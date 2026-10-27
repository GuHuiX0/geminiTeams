import { decisionSchema, taskInputSchema, runtimeConfigSchema, inboundSchema, ConflictError } from './types.js';
import type { Artifact, Decision, InboundEvent, InboundInput, Job, ModelProvider, ModelRequest, RuntimeConfig, Task, TaskInput } from './types.js';
import { Store, uid } from './store.js';
import { ToolRegistry } from './tools.js';
import { z } from 'zod';

const defaults = { instant: 1, focused: 10, deep: 30, persistent: 100 };
const terminal = (task: Task) => ['completed', 'cancelled', 'failed'].includes(task.state);
const settled = (job: Job) => ['completed', 'failed', 'cancelled'].includes(job.state);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4000);
interface Active { taskId: string; lane: Task['lane']; abort: AbortController; promise: Promise<void> }

export class Runtime {
  readonly config: RuntimeConfig;
  readonly tools: ToolRegistry;
  private active = new Map<string, Active>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private ownsStore = false;
  constructor(readonly store: Store, readonly provider: ModelProvider,
    options: Partial<RuntimeConfig> = {}, tools = new ToolRegistry()) {
    this.config = runtimeConfigSchema.parse(options); this.tools = tools;
  }
  start(): this {
    if (this.interval) return this;
    if (this.stopped) throw new Error('A stopped Runtime cannot be restarted; construct a new instance.');
    this.store.acquireOwner(); this.ownsStore = true;
    try { this.recover(); } catch (error) { this.store.releaseOwner(); this.ownsStore = false; throw error; }
    this.interval = setInterval(() => this.safeTick(), this.config.tickMs);
    this.safeTick(); return this;
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.interval) clearInterval(this.interval); this.interval = undefined;
    this.store.transaction(() => {
      for (const [id, active] of this.active) {
        const job = this.store.require('jobs', id); const task = this.store.require('tasks', job.taskId);
        if (job.state === 'running') this.interruptJob(job, task);
        active.abort.abort(new Error('Runtime stopped'));
      }
      this.store.append(null, 'runtime.stopped', {});
    });
    await Promise.all([...this.active.values()].map(a => a.promise));
    if (this.ownsStore) { this.store.releaseOwner(); this.ownsStore = false; }
  }
  submit(input: TaskInput): Task {
    const data = taskInputSchema.parse(input); const now = Date.now();
    for (const name of data.allowedTools) if (!this.tools.effect(name)) throw new Error(`Unknown tool: ${name}`);
    const task: Task = {
      ...data, id: uid(), lane: ['instant', 'focused'].includes(data.policy) ? 'interactive' : 'background',
      maxCalls: data.maxCalls ?? defaults[data.policy], state: 'active', revision: 1, calls: 0,
      activeSince: now, wakeVersion: 0, createdAt: now, updatedAt: now,
      virtualRuntime: Math.min(...this.store.all('tasks').filter(t => t.state === 'active').map(t => t.virtualRuntime).concat([Number.MAX_SAFE_INTEGER])),
      latestArtifactId: null, stopReason: null,
    };
    if (task.virtualRuntime === Number.MAX_SAFE_INTEGER) task.virtualRuntime = 0;
    this.store.transaction(() => {
      this.store.put('tasks', task); this.enqueue(task, 'controller', 'Deliver a first useful result.');
      this.store.append(task.id, 'task.created', task);
    });
    this.safeTick(); return task;
  }
  get(id: string) { return this.store.require('tasks', id); }
  list() { return this.store.all('tasks'); }
  artifacts(id: string): Artifact[] { this.get(id); return this.store.all('artifacts').filter(a => a.taskId === id); }
  jobs(id: string): Job[] { this.get(id); return this.store.all('jobs').filter(j => j.taskId === id); }

  pause(id: string): Task {
    const task = this.get(id); if (terminal(task)) throw new ConflictError('A terminal task cannot be paused.');
    this.store.transaction(() => {
      task.state = 'paused'; task.stopReason = 'Paused by user'; task.updatedAt = Date.now();
      for (const job of this.jobs(id).filter(j => j.state === 'running')) this.interruptJob(job, task);
      this.store.put('tasks', task); this.store.append(id, 'task.paused', { reason: task.stopReason });
    });
    this.abortTask(id); return this.get(id);
  }
  resume(id: string, extraCalls = 0): Task {
    const extra = z.number().int().min(0).max(1000).parse(extraCalls);
    const task = this.get(id);
    if (!['paused', 'waiting'].includes(task.state)) throw new ConflictError('Only a paused or waiting task can resume.');
    if (this.jobs(id).some(j => j.state === 'uncertain')) throw new ConflictError('Reconcile uncertain write jobs before resuming.');
    if (task.calls >= task.maxCalls + extra) throw new ConflictError('Call budget exhausted; resume with extraCalls.');
    this.store.transaction(() => {
      task.maxCalls += extra; task.state = 'active'; task.activeSince = Date.now(); task.stopReason = null;
      task.updatedAt = Date.now(); this.store.put('tasks', task);
      if (!this.jobs(id).some(j => j.revision === task.revision && ['queued', 'running'].includes(j.state))) {
        this.enqueue(task, 'controller', 'Resume using existing evidence and user direction.');
      }
      this.store.append(id, 'task.resumed', { extraCalls: extra });
    });
    this.safeTick(); return this.get(id);
  }
  steer(id: string, intent: string): Task {
    const direction = z.string().trim().min(1).max(32000).parse(intent); const task = this.get(id);
    if (terminal(task)) throw new ConflictError('A terminal task cannot be steered; submit a new task.');
    if (this.jobs(id).some(j => j.state === 'uncertain' ||
      (j.state === 'running' && j.kind === 'tool' && this.tools.effect(j.tool!) === 'write'))) {
      throw new ConflictError('Pause and reconcile in-flight writes before steering.');
    }
    this.store.transaction(() => {
      for (const job of this.jobs(id).filter(j => ['queued', 'running'].includes(j.state))) {
        job.state = 'cancelled'; this.store.put('jobs', job);
      }
      task.intent = direction; task.revision++; task.state = 'active'; task.activeSince = Date.now();
      task.latestArtifactId = null; task.stopReason = null; task.updatedAt = Date.now(); this.store.put('tasks', task);
      this.enqueue(task, 'controller', 'The user changed direction. Produce a useful result for the revised intent.');
      this.store.append(id, 'task.steered', { intent: direction, revision: task.revision });
    });
    this.abortTask(id); this.safeTick(); return this.get(id);
  }
  cancel(id: string): Task {
    const task = this.get(id); if (terminal(task)) return task;
    this.store.transaction(() => {
      task.state = 'cancelled'; task.stopReason = 'Cancelled by user'; task.updatedAt = Date.now();
      for (const job of this.jobs(id).filter(j => ['queued', 'running'].includes(j.state))) {
        if (job.state === 'running' && job.kind === 'tool' && this.tools.effect(job.tool!) !== 'read') job.state = 'uncertain';
        else job.state = 'cancelled';
        this.store.put('jobs', job);
      }
      this.store.put('tasks', task); this.store.append(id, 'task.cancelled', {});
    });
    this.abortTask(id); return task;
  }
  reconcile(jobId: string, observedResult: string): void {
    const result = z.string().min(1).max(100000).parse(observedResult);
    const job = this.store.require('jobs', jobId);
    if (job.state !== 'uncertain') throw new ConflictError('Only uncertain jobs need reconciliation.');
    this.store.transaction(() => {
      job.state = 'completed'; job.result = `User-reconciled outcome: ${result}`; this.store.put('jobs', job);
      this.store.append(job.taskId, 'tool.reconciled', { jobId, result });
    });
  }
  remember(taskId: string, key: string, value: string, source = 'user'): void {
    this.get(taskId);
    z.object({ key: z.string().min(1).max(200), value: z.string().max(32000), source: z.string().min(1).max(1000) }).parse({ key, value, source });
    const old = this.store.all('memory').find(m => m.taskId === taskId && m.key === key);
    this.store.transaction(() => {
      const memory = { id: old?.id ?? uid(), taskId, key, value, source, confidence: 'unverified' as const,
        version: (old?.version ?? 0) + 1, updatedAt: Date.now() };
      this.store.put('memory', memory); this.store.append(taskId, 'memory.updated', memory);
    });
  }
  subscribe(taskId: string, source: string, subject = '*', type = '*'): string {
    this.get(taskId);
    for (const field of [source, subject, type]) z.string().min(1).max(1000).parse(field);
    const id = uid(); this.store.put('subscriptions', { id, taskId, source, subject, type });
    this.store.append(taskId, 'subscription.created', { id, source, subject, type }); return id;
  }
  timer(taskId: string, dueAt: number, intervalMs: number | null = null): string {
    this.get(taskId); z.number().int().nonnegative().parse(dueAt);
    if (intervalMs !== null) z.number().int().min(100).parse(intervalMs);
    const id = uid(); this.store.put('timers', { id, taskId, dueAt, intervalMs, fired: 0 });
    this.store.append(taskId, 'timer.created', { id, dueAt, intervalMs }); return id;
  }
  ingest(input: InboundInput): { accepted: boolean; routed: number } {
    const parsed = inboundSchema.parse(input);
    const event: InboundEvent = { ...parsed, id: parsed.id ?? uid() };
    if (JSON.stringify(event).length > 65536) throw new Error('Event exceeds 64 KiB limit');
    return this.store.transaction(() => {
      if (!this.store.receipt(JSON.stringify([event.source, event.id]))) return { accepted: false, routed: 0 };
      let routed = 0;
      const matches = (pattern: string, text: string) => pattern === '*' || pattern === text ||
        (pattern.endsWith('*') && text.startsWith(pattern.slice(0, -1)));
      const taskIds = new Set(this.store.all('subscriptions').filter(s => s.source === event.source &&
        matches(s.subject, event.subject) && matches(s.type, event.type)).map(s => s.taskId));
      for (const taskId of taskIds) {
        if (taskId === event.originTaskId || event.causation.includes(taskId) || event.causation.length >= 16) continue;
        if (terminal(this.get(taskId))) continue;
        this.deliverLater(taskId, event, this.config.debounceMs); routed++;
      }
      this.store.append(null, 'event.ingested', { event, routed }); return { accepted: true, routed };
    });
  }
  private deliverLater(taskId: string, event: InboundEvent, delay: number): void {
    const old = this.store.all('deliveries').find(d => d.state === 'pending' && d.taskId === taskId &&
      d.event.source === event.source && d.event.subject === event.subject && d.event.type === event.type);
    const now = Date.now();
    this.store.put('deliveries', { id: old?.id ?? uid(), taskId, event,
      firstAt: old?.firstAt ?? now, count: (old?.count ?? 0) + 1,
      dueAt: Math.min(now + delay, (old?.firstAt ?? now) + Math.max(100, delay * 5)), state: 'pending' });
  }
  private enqueue(task: Task, kind: Job['kind'], instruction: string,
    dependsOn: string[] = [], tool: string | null = null, inputJson: string | null = null): string {
    const job: Job = { id: uid(), taskId: task.id, revision: task.revision, kind, instruction,
      tool, inputJson, wakeVersion: task.wakeVersion, dependsOn, state: 'queued', attempts: 0,
      availableAt: Date.now(), result: null, error: null, createdAt: Date.now() };
    this.store.put('jobs', job); return job.id;
  }
  private abortTask(id: string): void {
    for (const active of this.active.values()) if (active.taskId === id) active.abort.abort(new Error('Task interrupted'));
  }
  private interruptJob(job: Job, task: Task): void {
    if (job.kind === 'tool' && this.tools.effect(job.tool!) !== 'read') {
      job.state = 'uncertain'; task.state = 'paused'; task.stopReason = 'Interrupted write needs reconciliation';
      this.store.append(task.id, 'tool.uncertain', { jobId: job.id, reason: task.stopReason });
    } else job.state = 'queued';
    this.store.put('jobs', job); this.store.put('tasks', task);
  }
  private recover(): void {
    this.store.transaction(() => {
      for (const job of this.store.all('jobs').filter(j => j.state === 'running')) {
        const task = this.get(job.taskId); this.interruptJob(job, task);
        this.store.append(task.id, 'job.recovered', { jobId: job.id, state: job.state });
      }
      this.store.append(null, 'runtime.started', { config: this.config });
    });
  }
  private safeTick(): void {
    if (this.stopped || !this.interval) return;
    try { this.tick(); } catch (error) { this.store.append(null, 'runtime.error', { error: errorText(error) }); }
  }
  private tick(): void {
    const now = Date.now();
    this.store.transaction(() => {
      for (const timer of this.store.all('timers').filter(t => t.dueAt <= now)) {
        const task = this.get(timer.taskId);
        if (terminal(task)) { this.store.remove('timers', timer.id); continue; }
        const event: InboundEvent = { id: `${timer.id}:${timer.fired}`, source: 'timer', subject: timer.id,
          type: 'timer.fired', payload: { scheduledAt: timer.dueAt }, causation: [] };
        this.deliverLater(task.id, event, 0); timer.fired++;
        if (timer.intervalMs) { timer.dueAt = now + timer.intervalMs; this.store.put('timers', timer); }
        else this.store.remove('timers', timer.id);
      }
      for (const delivery of this.store.all('deliveries').filter(d => d.state === 'pending' && d.dueAt <= now)) {
        const task = this.get(delivery.taskId);
        if (task.state === 'paused') continue;
        delivery.state = 'delivered'; this.store.put('deliveries', delivery);
        if (terminal(task)) continue;
        task.wakeVersion++;
        if (task.state === 'waiting') {
          task.state = 'active'; task.activeSince = now; task.stopReason = null;
          this.enqueue(task, 'controller', 'A subscribed event arrived. Reassess and deliver a useful update.');
        }
        this.store.put('tasks', task);
        this.store.append(task.id, 'task.event', { event: delivery.event, coalescedCount: delivery.count });
      }
      for (const task of this.list().filter(t => t.state === 'active' && now - t.activeSince > t.maxDurationMs)) {
        this.pause(task.id); const current = this.get(task.id); current.stopReason = 'Active-time deadline reached';
        this.store.put('tasks', current); this.store.append(task.id, 'task.limit', { reason: current.stopReason });
      }
    });
    for (const lane of ['interactive', 'background'] as const) {
      const capacity = lane === 'interactive' ? this.config.interactiveSlots : this.config.backgroundSlots;
      while ([...this.active.values()].filter(a => a.lane === lane).length < capacity) {
        const candidate = this.nextJob(lane); if (!candidate) break; this.launch(candidate);
      }
    }
  }
  private nextJob(lane: Task['lane']): Job | undefined {
    const jobs = this.store.all('jobs'); const now = Date.now();
    const tasks = this.list().filter(t => t.state === 'active' && t.lane === lane)
      .sort((a, b) => a.virtualRuntime - b.virtualRuntime || a.createdAt - b.createdAt);
    for (const task of tasks) {
      if ([...this.active.values()].filter(a => a.taskId === task.id).length >= Math.min(task.maxParallel, this.config.maxWorkersPerTask)) continue;
      const job = jobs.find(j => j.taskId === task.id && j.revision === task.revision && j.state === 'queued' &&
        j.availableAt <= now && !this.active.has(j.id) && j.dependsOn.every(id => {
          const dependency = jobs.find(d => d.id === id); return dependency && settled(dependency);
        }));
      if (!job) continue;
      if (job.kind !== 'tool' && task.calls >= task.maxCalls) {
        // Let already-started siblings checkpoint before pausing the task.
        if ([...this.active.values()].some(a => a.taskId === task.id)) continue;
        task.state = 'paused'; task.stopReason = 'Model-call budget exhausted'; this.store.put('tasks', task);
        this.store.append(task.id, 'task.limit', { reason: task.stopReason, attention: 'decision' }); continue;
      }
      return job;
    }
    return undefined;
  }
  private launch(job: Job): void {
    const task = this.get(job.taskId); const abort = new AbortController();
    const entry: Active = { taskId: task.id, lane: task.lane, abort, promise: Promise.resolve() };
    this.active.set(job.id, entry);
    try { this.store.transaction(() => {
      job.state = 'running'; job.attempts++; job.wakeVersion = task.wakeVersion;
      if (job.kind !== 'tool') task.calls++;
      task.virtualRuntime += 1 / task.priority; task.updatedAt = Date.now();
      this.store.put('jobs', job); this.store.put('tasks', task);
      this.store.append(task.id, 'job.started', { jobId: job.id, kind: job.kind, attempt: job.attempts });
    }); } catch (error) { this.active.delete(job.id); throw error; }
    // Observers may pause or cancel on job.started; their signal is already installed.
    entry.promise = this.execute(task, job, abort.signal).finally(() => {
      this.active.delete(job.id); this.safeTick();
    });
  }
  private context(task: Task, job: Job): ModelRequest {
    return { task, job,
      artifacts: this.artifacts(task.id).slice(-5)
        .map(a => ({ ...a, body: a.body.slice(0, 16000) })),
      observations: this.jobs(task.id).filter(j => j.kind !== 'controller' && settled(j))
        .slice(-20).map(j => ({ instruction: (j.revision === task.revision ? '' : `[Historical revision ${j.revision}] `) + j.instruction, result: (j.result ?? `Failed: ${j.error}`).slice(0, 12000) })),
      memory: this.store.all('memory').filter(m => m.taskId === task.id).slice(-20),
      mailbox: this.store.all('deliveries').filter(d => d.taskId === task.id && d.state === 'delivered').slice(-10).map(d => d.event),
      tools: this.tools.descriptions(task.allowedTools), };
  }
  private async execute(task: Task, job: Job, parentSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(this.config.jobTimeoutMs)]);
    let onAbort: (() => void) | undefined;
    try {
      parentSignal.throwIfAborted();
      const operation = job.kind === 'tool'
        ? this.tools.execute(job.tool!, job.inputJson!, task.allowedTools,
          { taskId: task.id, jobId: job.id, idempotencyKey: job.id, signal })
        : this.provider.execute(this.context(task, job), signal);
      const result = await Promise.race([operation, new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
      signal.throwIfAborted();
      const current = this.get(task.id); const savedJob = this.store.require('jobs', job.id);
      if (current.revision !== job.revision || current.state !== 'active' || savedJob.state !== 'running') return;
      this.store.transaction(() => {
        if (job.kind === 'controller') this.applyDecision(current, job, decisionSchema.parse(result));
        else if (typeof result !== 'string') throw new Error('Worker must return a string');
        job.state = 'completed'; job.result = typeof result === 'string' ? result.slice(0, 100000) : JSON.stringify(result);
        job.error = null; this.store.put('jobs', job);
        this.store.append(task.id, 'job.completed', { jobId: job.id, kind: job.kind });
      });
    } catch (error) {
      const current = this.get(task.id); const saved = this.store.require('jobs', job.id);
      if (current.revision !== job.revision || current.state !== 'active' || saved.state !== 'running') return;
      this.store.transaction(() => {
        job.error = errorText(error);
        if (job.kind === 'tool' && this.tools.effect(job.tool!) !== 'read') {
          job.state = 'uncertain'; this.store.put('jobs', job);
          // Pause and checkpoint every sibling too; no running job may become orphaned.
          this.pause(task.id);
          const paused = this.get(task.id); paused.stopReason = 'Write outcome needs reconciliation';
          this.store.put('tasks', paused);
          this.store.append(task.id, 'tool.uncertain', { jobId: job.id, error: job.error, attention: 'decision' });
        } else if (job.attempts < this.config.maxAttempts && !parentSignal.aborted) {
          job.state = 'queued'; job.availableAt = Date.now() + Math.min(10000, 250 * 2 ** (job.attempts - 1)) + Math.floor(Math.random() * 100);
          this.store.append(task.id, 'job.retry', { jobId: job.id, error: job.error, availableAt: job.availableAt });
        } else {
          job.state = 'failed';
          if (job.kind === 'controller') {
            current.state = 'failed'; current.stopReason = job.error; this.store.put('tasks', current);
            this.store.append(task.id, 'task.failed', { error: job.error });
          }
          this.store.append(task.id, 'job.failed', { jobId: job.id, error: job.error });
        }
        this.store.put('jobs', job);
      });
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  }
  private applyDecision(task: Task, job: Job, decision: Decision): void {
    if (decision.next !== 'continue' && decision.operations.length) throw new Error('Terminal/wait decisions cannot request operations');
    if (decision.next === 'continue' && !decision.operations.length) throw new Error('Continue requires useful operations');
    if (!task.latestArtifactId && !decision.artifact) throw new Error('The first controller call must deliver a useful artifact');
    if (task.policy === 'instant' && decision.next !== 'complete') throw new Error('Instant policy must complete in one call');
    for (const op of decision.operations) {
      if (op.kind === 'tool') this.tools.validate(op.tool ?? '', op.inputJson ?? '', task.allowedTools);
    }
    if (decision.artifact) {
      const artifact: Artifact = { ...decision.artifact, id: uid(), taskId: task.id, revision: task.revision, createdAt: Date.now() };
      if (!artifact.evidence.length) artifact.confidence = 'unverified';
      this.store.put('artifacts', artifact); task.latestArtifactId = artifact.id;
      this.store.append(task.id, 'artifact.published', { artifact, attention: 'passive',
        timeToFirstUsefulResultMs: this.artifacts(task.id).length === 1 ? Date.now() - task.createdAt : null });
    }
    const requiredCalls = decision.operations.filter(o => o.kind === 'reason').length + 1;
    if (decision.next === 'continue' && task.maxCalls - task.calls < requiredCalls) {
      task.state = 'paused'; task.stopReason = 'Insufficient call budget for branches and synthesis';
      this.store.append(task.id, 'task.limit', { reason: task.stopReason, attention: 'decision' });
    } else if (decision.next === 'continue') {
      if (task.lane === 'interactive') {
        task.lane = 'background';
        this.store.append(task.id, 'task.escalated', { lane: task.lane, reason: 'Further work continues in background capacity' });
      }
      const dependencies = decision.operations.map(op => this.enqueue(task, op.kind, op.instruction, [], op.tool, op.inputJson));
      this.enqueue(task, 'controller', 'Synthesize new observations. Improve the artifact only if useful; stop when sufficient.', dependencies);
    } else if (task.wakeVersion > job.wakeVersion) {
      this.enqueue(task, 'controller', 'An event arrived during the last call. Reassess the latest mailbox before stopping.');
    } else {
      task.state = decision.next === 'wait' ? 'waiting' : 'completed'; task.stopReason = decision.reason;
      this.store.append(task.id, task.state === 'waiting' ? 'task.waiting' : 'task.completed',
        { reason: decision.reason, attention: task.state === 'completed' ? 'notify' : 'passive' });
    }
    task.updatedAt = Date.now(); this.store.put('tasks', task);
  }
}
