import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Runtime, Store, ToolRegistry } from '../src/index.js';
import { abortableDelay } from '../src/tools.js';
import { answer, branch, delay, fixture, provider, until } from './helpers.js';

// Assertions about independent work use barriers instead of assuming real model latency.
test('interactive request completes while every background slot is occupied', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let busy = 0;
  const { runtime } = fixture(t, provider(async request => {
    if (request.task.lane === 'background') { busy++; await gate; }
    return answer(request.task.intent);
  }), { backgroundSlots: 2, interactiveSlots: 1 });
  runtime.start();
  const a = runtime.submit({ intent: 'Background A', policy: 'deep' });
  runtime.submit({ intent: 'Background B', policy: 'deep' });
  await until(() => busy === 2);
  const quick = runtime.submit({ intent: 'Quick', policy: 'instant' });
  await until(() => runtime.get(quick.id).state === 'completed');
  assert.equal(runtime.get(a.id).state, 'active');
  assert.equal(runtime.get(quick.id).calls, 1);
  release();
});

test('publishes initial artifact before parallel work; respects global and per-task bounds', async t => {
  let workers = 0, peak = 0;
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const { runtime } = fixture(t, provider(async request => {
    if (request.job.kind === 'reason') {
      workers++; peak = Math.max(peak, workers); await gate; workers--; return 'Finding';
    }
    return request.artifacts.length ? answer('Synthesis') : branch('A', 'B', 'C');
  }), { backgroundSlots: 3, maxWorkersPerTask: 2 });
  runtime.start(); const task = runtime.submit({ intent: 'Research', policy: 'deep', maxParallel: 2 });
  await until(() => workers === 2);
  assert.equal(runtime.artifacts(task.id)[0]?.body, 'Initial useful result');
  assert.equal(runtime.get(task.id).state, 'active'); release();
  await until(() => runtime.get(task.id).state === 'completed');
  assert.equal(peak, 2); assert.equal(runtime.get(task.id).calls, 5);
  assert.equal(runtime.artifacts(task.id).length, 2);
});

test('steering fences stale results and preserves previous artifacts for audit', async t => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let oldStarted = false;
  const { runtime } = fixture(t, provider(async request => {
    if (request.task.revision === 1) { oldStarted = true; await gate; return answer('Stale'); }
    return answer('New intent');
  }));
  runtime.start(); const task = runtime.submit({ intent: 'Original', policy: 'deep' });
  await until(() => oldStarted); runtime.steer(task.id, 'New goal'); release();
  await until(() => runtime.get(task.id).state === 'completed');
  assert.equal(runtime.get(task.id).revision, 2);
  assert.deepEqual(runtime.artifacts(task.id).map(a => a.body), ['New intent']);
});

test('pause aborts pending work and resume reuses task without stale commits', async t => {
  let started = 0;
  const { runtime } = fixture(t, provider(async (_, signal) => {
    started++; await abortableDelay(60, signal); return answer();
  }));
  runtime.start(); const task = runtime.submit({ intent: 'Pause me', policy: 'deep' });
  await until(() => started === 1); runtime.pause(task.id); await delay(80);
  assert.equal(runtime.get(task.id).state, 'paused'); assert.equal(runtime.artifacts(task.id).length, 0);
  runtime.resume(task.id); await until(() => runtime.get(task.id).state === 'completed');
  assert.equal(started, 2);
});

test('cancellation retains partial results and does not resurrect task', async t => {
  let workerStarted = false;
  const { runtime } = fixture(t, provider(async (request, signal) => {
    if (request.job.kind === 'reason') { workerStarted = true; await abortableDelay(100, signal); return 'late'; }
    return branch('Long branch');
  }));
  runtime.start(); const task = runtime.submit({ intent: 'Cancel me', policy: 'deep' });
  await until(() => workerStarted); runtime.cancel(task.id); await delay(120);
  assert.equal(runtime.get(task.id).state, 'cancelled'); assert.equal(runtime.artifacts(task.id).length, 1);
  assert.throws(() => runtime.resume(task.id), /Only a paused/);
});

test('reserves a synthesis call and pauses without exceeding budget', async t => {
  const { runtime } = fixture(t, provider(() => branch('A', 'B')));
  runtime.start(); const task = runtime.submit({ intent: 'Small budget', policy: 'deep', maxCalls: 3 });
  await until(() => runtime.get(task.id).state === 'paused');
  assert.equal(runtime.get(task.id).calls, 1); assert.match(runtime.get(task.id).stopReason!, /budget/);
  assert.equal(runtime.jobs(task.id).length, 1); assert.equal(runtime.artifacts(task.id).length, 1);
});

test('invalid initial output is retried a bounded number of times', async t => {
  const { runtime } = fixture(t, provider(() => ({ ...answer(), artifact: null })), { maxAttempts: 2 });
  runtime.start(); const task = runtime.submit({ intent: 'Needs an artifact', policy: 'deep' });
  await until(() => runtime.get(task.id).state === 'failed');
  assert.equal(runtime.get(task.id).calls, 2); assert.equal(runtime.artifacts(task.id).length, 0);
});

test('transient failures retry and publish exactly one successful artifact', async t => {
  let calls = 0;
  const { runtime } = fixture(t, provider(() => { if (++calls === 1) throw new Error('429 rate limited'); return answer(); }));
  runtime.start(); const task = runtime.submit({ intent: 'Retry', policy: 'focused' });
  await until(() => runtime.get(task.id).state === 'completed');
  assert.equal(calls, 2); assert.equal(runtime.artifacts(task.id).length, 1);
  assert.ok(runtime.store.events(0, task.id).some(e => e.kind === 'job.retry'));
});

test('timeouts release a model slot even if a provider ignores cancellation', async t => {
  const { runtime } = fixture(t, provider(request => request.task.intent === 'Hang'
    ? new Promise(() => {}) : answer()), { jobTimeoutMs: 20, maxAttempts: 1, interactiveSlots: 1 });
  runtime.start(); const hung = runtime.submit({ intent: 'Hang', policy: 'focused' });
  const next = runtime.submit({ intent: 'Next', policy: 'instant' });
  await until(() => runtime.get(next.id).state === 'completed');
  assert.equal(runtime.get(hung.id).state, 'failed');
});

test('unauthorized tool requests cannot execute or publish a misleading artifact', async t => {
  let writes = 0;
  const tools = new ToolRegistry().register({ name: 'write', description: 'write', effect: 'write',
    schema: z.object({}), resources: () => ['resource'], execute: () => { writes++; return 'wrote'; } });
  const { runtime } = fixture(t, provider(() => ({ ...branch('write'), operations: [
    { kind: 'tool', instruction: 'write', tool: 'write', inputJson: '{}' },
  ] })), { maxAttempts: 1 }, tools);
  runtime.start(); const task = runtime.submit({ intent: 'No write permission', policy: 'deep' });
  await until(() => runtime.get(task.id).state === 'failed');
  assert.equal(writes, 0); assert.equal(runtime.artifacts(task.id).length, 0);
});

test('failed writes become uncertain and are never automatically retried', async t => {
  let writes = 0;
  const tools = new ToolRegistry().register({ name: 'write', description: 'write', effect: 'write', schema: z.object({}),
    resources: () => ['resource'], execute: () => { writes++; throw new Error('connection lost after possible write'); } });
  const { runtime } = fixture(t, provider(request => request.artifacts.length ? answer('Reconciled synthesis') : {
    ...branch('write'), operations: [{ kind: 'tool', instruction: 'write', tool: 'write', inputJson: '{}' }],
  }), {}, tools);
  runtime.start(); const task = runtime.submit({ intent: 'Authorized write', policy: 'deep', allowedTools: ['write'] });
  await until(() => runtime.get(task.id).state === 'paused');
  const job = runtime.jobs(task.id).find(j => j.state === 'uncertain')!;
  assert.equal(writes, 1); assert.ok(job); assert.throws(() => runtime.resume(task.id), /Reconcile/);
  runtime.reconcile(job.id, 'Verified externally: write succeeded'); runtime.resume(task.id);
  await until(() => runtime.get(task.id).state === 'completed'); assert.equal(writes, 1);
});

test('crash recovery requeues reasoning and isolates uncertain side effects', async t => {
  const model = provider(() => answer('Recovered'));
  const { runtime, store } = fixture(t, model);
  const safe = runtime.submit({ intent: 'Interrupted read', policy: 'deep' });
  const risky = runtime.submit({ intent: 'Interrupted external write', policy: 'deep' });
  const a = runtime.jobs(safe.id)[0]!; a.state = 'running'; a.attempts = 1; store.put('jobs', a);
  const b = runtime.jobs(risky.id)[0]!; b.kind = 'tool'; b.tool = 'external_write'; b.inputJson = '{}'; b.state = 'running'; store.put('jobs', b);
  // Missing adapter on restart is also an unknown side effect, not a reason to replay it.
  runtime.start(); await until(() => runtime.get(safe.id).state === 'completed');
  assert.equal(runtime.get(risky.id).state, 'paused');
  assert.equal(runtime.jobs(risky.id)[0]?.state, 'uncertain');
});

test('database owner lock prevents two schedulers and releases on stop', async t => {
  const { runtime, path } = fixture(t, provider(() => answer())); runtime.start();
  const secondStore = new Store(path); const second = new Runtime(secondStore, provider(() => answer()));
  assert.throws(() => second.start(), /already owns/);
  await runtime.stop(); second.start(); await second.stop(); secondStore.close();
});

test('memory records retain provenance and versioned update events', async t => {
  const { runtime, store } = fixture(t, provider(() => answer()));
  const task = runtime.submit({ intent: 'Remember constraints' });
  runtime.remember(task.id, 'constraint', 'A', 'user instruction');
  runtime.remember(task.id, 'constraint', 'B', 'updated instruction');
  const memory = store.all('memory')[0]!;
  assert.equal(memory.version, 2); assert.equal(memory.source, 'updated instruction');
  assert.equal(store.events(0, task.id).filter(e => e.kind === 'memory.updated').length, 2);
});

test('a failed write checkpoints parallel siblings so reconciliation cannot strand a running job', async t => {
  let wrote = false;
  const tools = new ToolRegistry().register({ name: 'write', description: 'write', effect: 'write', schema: z.object({}),
    resources: () => ['resource'], execute: async () => { await delay(10); wrote = true; throw new Error('unknown write'); } });
  const { runtime } = fixture(t, provider(async (request, signal) => {
    if (request.job.kind === 'reason') { await abortableDelay(80, signal); return 'Safe result'; }
    if (request.artifacts.length) return answer('Done after reconciliation');
    return { ...branch('A'), operations: [
      { kind: 'reason', instruction: 'Slow sibling', tool: null, inputJson: null },
      { kind: 'tool', instruction: 'Write', tool: 'write', inputJson: '{}' },
    ] };
  }), { backgroundSlots: 3 }, tools);
  runtime.start(); const task = runtime.submit({ intent: 'Concurrent write', policy: 'deep', allowedTools: ['write'] });
  await until(() => wrote && runtime.get(task.id).state === 'paused'); await delay(10);
  assert.equal(runtime.jobs(task.id).filter(j => j.state === 'running').length, 0);
  const write = runtime.jobs(task.id).find(j => j.state === 'uncertain')!;
  runtime.reconcile(write.id, 'Observed committed'); runtime.resume(task.id);
  await until(() => runtime.get(task.id).state === 'completed');
});

test('focused tasks move further work to background slots after their first result', async t => {
  const { runtime } = fixture(t, provider(request => request.job.kind === 'reason' ? 'Finding' :
    request.artifacts.length ? answer() : branch('Explore')));
  runtime.start(); const task = runtime.submit({ intent: 'Expand only if useful', policy: 'focused' });
  await until(() => runtime.get(task.id).state === 'completed');
  assert.equal(runtime.get(task.id).lane, 'background');
  assert.ok(runtime.store.events(0, task.id).some(e => e.kind === 'task.escalated'));
});

test('redirected tasks can reuse historical artifacts without accepting stale output', async t => {
  let historical = false;
  const { runtime } = fixture(t, provider(request => {
    if (request.task.revision > 1) {
      historical = request.artifacts.some(a => a.revision === 1);
      return answer('Revised result');
    }
    return answer('Prior useful context', 'wait');
  }));
  runtime.start(); const task = runtime.submit({ intent: 'Original', policy: 'persistent' });
  await until(() => runtime.get(task.id).state === 'waiting'); runtime.steer(task.id, 'Revised');
  await until(() => runtime.get(task.id).state === 'completed');
  assert.ok(historical); assert.equal(runtime.artifacts(task.id).length, 2);
});
