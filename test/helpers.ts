import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Runtime, Store, ToolRegistry } from '../src/index.js';
import type { Decision, ModelProvider, ModelRequest, RuntimeConfig } from '../src/index.js';
export const answer = (body = 'A useful answer', next: Decision['next'] = 'complete'): Decision => ({
  artifact: { title: 'Result', body, confidence: 'unverified', evidence: [] }, next, operations: [], reason: 'Enough information',
});
export const branch = (...instructions: string[]): Decision => ({
  ...answer('Initial useful result'), next: 'continue', operations: instructions.map(instruction =>
    ({ kind: 'reason', instruction, tool: null, inputJson: null })),
});
export function provider(fn: (request: ModelRequest, signal: AbortSignal) => Promise<Decision | string> | Decision | string): ModelProvider {
  return { execute: async (request, signal) => fn(request, signal) };
}
export async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await delay(5); }
}
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function fixture(t: TestContext, model: ModelProvider, config: Partial<RuntimeConfig> = {}, tools = new ToolRegistry()) {
  const dir = mkdtempSync(join(tmpdir(), 'living-test-')); const path = join(dir, 'state.sqlite');
  const store = new Store(path); const runtime = new Runtime(store, model, { tickMs: 5, debounceMs: 15, ...config }, tools);
  t.after(async () => { await runtime.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { runtime, store, dir, path };
}
