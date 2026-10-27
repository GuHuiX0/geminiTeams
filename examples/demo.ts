import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoProvider, Runtime, Store } from '../src/index.js';

const directory = mkdtempSync(join(tmpdir(), 'living-demo-'));
const store = new Store(join(directory, 'demo.sqlite'));
const runtime = new Runtime(store, new DemoProvider(), { backgroundSlots: 2, interactiveSlots: 1, debounceMs: 20 }).start();
const startedAt = Date.now();
store.onEvent(event => {
  if (['task.created', 'artifact.published', 'task.completed', 'task.waiting', 'task.event'].includes(event.kind)) {
    const data = event.data as { artifact?: { title: string } };
    console.log(`+${String(Date.now() - startedAt).padStart(4)}ms ${event.taskId?.slice(0, 8)} ${event.kind} ${data.artifact?.title ?? ''}`);
  }
});
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Demo timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
try {
  console.log('OFFLINE DEMO — scripted responses; no Gemini calls, no real research.\n');
  const deep = runtime.submit({ intent: 'Explore a general-purpose agent runtime', policy: 'deep' });
  const instant = runtime.submit({ intent: 'Give a quick answer', policy: 'instant' });
  await until(() => runtime.get(instant.id).state === 'completed');
  console.log(`\nQuick task completed while deep task is ${runtime.get(deep.id).state}.\n`);
  const persistent = runtime.submit({ intent: 'Maintain an evolving research question', policy: 'persistent' });
  runtime.subscribe(persistent.id, 'research', 'papers/*', 'new-evidence');
  await until(() => runtime.get(persistent.id).state === 'waiting' && runtime.get(deep.id).state === 'completed');
  console.log('\nPersistent task is idle and making zero model calls. Delivering an event...\n');
  const event = { id: 'paper-1', source: 'research', subject: 'papers/actors', type: 'new-evidence', payload: { summary: 'A new observation' } };
  console.log('First delivery:', runtime.ingest(event));
  console.log('Duplicate:', runtime.ingest(event));
  const before = runtime.get(persistent.id).calls;
  await until(() => runtime.get(persistent.id).calls > before && runtime.get(persistent.id).state === 'waiting');
  console.log('\nLatest deep-task artifact:\n' + runtime.artifacts(deep.id).at(-1)?.body);
} finally {
  await runtime.stop(); store.close(); rmSync(directory, { recursive: true, force: true });
}
