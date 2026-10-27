import { realpathSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDescription } from './types.js';

export interface ToolContext { taskId: string; jobId: string; idempotencyKey: string; signal: AbortSignal }
export interface ToolSpec<T> {
  name: string; description: string; effect: 'read' | 'write'; schema: z.ZodType<T>;
  resources: (input: T) => string[];
  execute: (input: T, context: ToolContext) => Promise<string> | string;
}
interface RegisteredTool {
  description: ToolDescription;
  prepare(input: unknown): { resources: string[]; execute(context: ToolContext): Promise<string> };
}
interface Held { token: string; resource: string; write: boolean }
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

/** Atomically acquires all resources; ancestor and descendant paths conflict. */
export class LeaseManager {
  private held: Held[] = [];
  async run<T>(resources: string[], write: boolean, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const normalized = resources.map(r => r.replaceAll('\\', '/').replace(/\/+$/, ''));
    while (this.held.some(h => (write || h.write) && normalized.some(r => overlaps(r, h.resource)))) {
      await abortableDelay(10, signal);
    }
    signal.throwIfAborted();
    const token = randomUUID();
    this.held.push(...normalized.map(resource => ({ resource, write, token })));
    try { return await fn(); } finally { this.held = this.held.filter(h => h.token !== token); }
  }
}
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveDelay(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private leases = new LeaseManager();
  register<T>(spec: ToolSpec<T>): this {
    if (this.tools.has(spec.name)) throw new Error(`Duplicate tool: ${spec.name}`);
    this.tools.set(spec.name, {
      description: { name: spec.name, description: spec.description, effect: spec.effect,
        inputSchema: z.toJSONSchema(spec.schema) },
      prepare(input) {
        const parsed = spec.schema.parse(input);
        return { resources: spec.resources(parsed), execute: async context => spec.execute(parsed, context) };
      },
    });
    return this;
  }
  descriptions(allowed: string[]): ToolDescription[] {
    return allowed.flatMap(name => { const tool = this.tools.get(name); return tool ? [tool.description] : []; });
  }
  effect(name: string): 'read' | 'write' | undefined { return this.tools.get(name)?.description.effect; }
  validate(name: string, inputJson: string, allowed: string[]): void {
    if (!allowed.includes(name)) throw new Error(`Tool not authorized for this task: ${name}`);
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    tool.prepare(JSON.parse(inputJson));
  }
  async execute(name: string, inputJson: string, allowed: string[], context: ToolContext): Promise<string> {
    this.validate(name, inputJson, allowed);
    const tool = this.tools.get(name)!;
    const prepared = tool.prepare(JSON.parse(inputJson));
    return this.leases.run(prepared.resources, tool.description.effect === 'write', context.signal,
      () => prepared.execute(context));
  }
}

/** Explicit opt-in filesystem adapter. No shell, GUI, network, or implicit home access. */
export function fileTools(root: string, allowWrites = false): ToolRegistry {
  const base = realpathSync(root);
  const inside = (path: string) => {
    if (path !== base && !path.startsWith(base + sep)) throw new Error('Path escapes configured workspace');
    return path;
  };
  const readPath = (path: string) => inside(realpathSync(resolve(base, path)));
  const writePath = (path: string) => {
    const candidate = resolve(base, path);
    inside(candidate);
    const parent = inside(realpathSync(dirname(candidate)));
    // Resolve an existing target too, to reject symlinks outside the root.
    try { inside(realpathSync(candidate)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return resolve(parent, candidate.slice(dirname(candidate).length + 1));
  };
  const registry = new ToolRegistry().register({
    name: 'file_read', description: 'Read a UTF-8 file under the configured workspace (up to 1 MiB).',
    effect: 'read', schema: z.object({ path: z.string().min(1) }),
    resources: input => ['file:' + readPath(input.path)],
    execute(input, context) {
      context.signal.throwIfAborted(); const path = readPath(input.path);
      if (statSync(path).size > 1048576) throw new Error('File exceeds 1 MiB read limit');
      return readFileSync(path, 'utf8');
    },
  });
  if (allowWrites) registry.register({
    name: 'file_write', description: 'Atomically replace a UTF-8 file under the configured workspace. Parent must exist.',
    effect: 'write', schema: z.object({ path: z.string().min(1), content: z.string().max(100000) }),
    resources: input => ['file:' + writePath(input.path)],
    execute(input, context) {
      context.signal.throwIfAborted(); const path = writePath(input.path); const temp = path + '.' + randomUUID() + '.tmp';
      try { writeFileSync(temp, input.content, { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
      finally { try { unlinkSync(temp); } catch { /* Rename already removed it. */ } }
      return `Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}`;
    },
  });
  return registry;
}
