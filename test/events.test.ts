import test from 'node:test';
import assert from 'node:assert/strict';
import { answer, delay, fixture, provider, until } from './helpers.js';

test('persistent tasks sleep without inference and wake only for subscribed events', async t => {
  let calls = 0;
  const { runtime } = fixture(t, provider(() => { calls++; return answer('Updated', 'wait'); }));
  runtime.start(); const task = runtime.submit({ intent: 'Monitor hypothesis', policy: 'persistent' });
  runtime.subscribe(task.id, 'files', 'project/*', 'changed');
  await until(() => runtime.get(task.id).state === 'waiting'); await delay(70); assert.equal(calls, 1);
  assert.equal(runtime.ingest({ source: 'unsubscribed', subject: 'project/a', type: 'changed' }).routed, 0);
  runtime.ingest({ source: 'files', subject: 'other/a', type: 'changed' });
  await delay(30); assert.equal(calls, 1);
  runtime.ingest({ source: 'files', subject: 'project/a', type: 'changed', payload: { revision: 2 } });
  await until(() => calls === 2 && runtime.get(task.id).state === 'waiting');
});

test('deduplicates events, coalesces a burst, and filters self-caused work', async t => {
  let observed: unknown;
  const { runtime } = fixture(t, provider(request => { observed = request.mailbox.at(-1)?.payload; return answer('Waiting', 'wait'); }), { debounceMs: 30 });
  runtime.start(); const task = runtime.submit({ intent: 'Watch', policy: 'persistent' });
  runtime.subscribe(task.id, 'files'); runtime.subscribe(task.id, 'files'); // Duplicate subscriptions still deliver once.
  await until(() => runtime.get(task.id).state === 'waiting');
  const input = { source: 'files', subject: 'project/a', type: 'changed' };
  assert.equal(runtime.ingest({ ...input, id: 'same', payload: 1 }).routed, 1);
  assert.equal(runtime.ingest({ ...input, id: 'same', payload: 2 }).accepted, false);
  runtime.ingest({ ...input, payload: 3 }); runtime.ingest({ ...input, payload: 4 });
  assert.equal(runtime.ingest({ ...input, originTaskId: task.id }).routed, 0);
  assert.equal(runtime.ingest({ ...input, causation: [task.id] }).routed, 0);
  await until(() => runtime.get(task.id).calls === 2 && runtime.get(task.id).state === 'waiting');
  assert.equal(observed, 4);
  const events = runtime.store.events(0, task.id).filter(e => e.kind === 'task.event');
  assert.equal(events.length, 1); assert.equal((events[0]!.data as { coalescedCount: number }).coalescedCount, 3);
});

test('paused tasks retain pending deliveries until explicitly resumed', async t => {
  const { runtime, store } = fixture(t, provider(() => answer('Wait', 'wait')));
  runtime.start(); const task = runtime.submit({ intent: 'Paused watch', policy: 'persistent' });
  runtime.subscribe(task.id, 'events'); await until(() => runtime.get(task.id).state === 'waiting');
  runtime.pause(task.id); runtime.ingest({ source: 'events', subject: 'x', type: 'new' }); await delay(40);
  assert.equal(store.all('deliveries')[0]?.state, 'pending');
  assert.equal(runtime.get(task.id).calls, 1); runtime.resume(task.id);
  await until(() => store.all('deliveries')[0]?.state === 'delivered' && runtime.get(task.id).state === 'waiting');
});

test('mail arriving during a terminal decision gets a follow-up call', async t => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let calls = 0;
  const { runtime } = fixture(t, provider(async request => {
    calls++; if (calls === 1) await gate;
    return answer(request.mailbox.length ? 'With new evidence' : 'Old snapshot', 'wait');
  }), { debounceMs: 0 });
  runtime.start(); const task = runtime.submit({ intent: 'Watch in-flight', policy: 'persistent' });
  runtime.subscribe(task.id, 'events'); runtime.ingest({ source: 'events', subject: 'x', type: 'new' });
  await until(() => runtime.get(task.id).wakeVersion === 1); release();
  await until(() => runtime.get(task.id).state === 'waiting');
  assert.equal(calls, 2); assert.equal(runtime.artifacts(task.id).at(-1)?.body, 'With new evidence');
});

test('durable timer wakes a waiting task and is removed after one delivery', async t => {
  const { runtime, store } = fixture(t, provider(() => answer('Wait', 'wait')));
  runtime.start(); const task = runtime.submit({ intent: 'Timer', policy: 'persistent' });
  await until(() => runtime.get(task.id).state === 'waiting'); runtime.timer(task.id, Date.now() + 20);
  await until(() => runtime.get(task.id).calls === 2 && runtime.get(task.id).state === 'waiting');
  assert.equal(store.all('timers').length, 0);
  assert.equal(store.all('deliveries')[0]?.event.source, 'timer');
});

test('active-time deadline pauses a hung task while retaining its checkpoint', async t => {
  const { runtime } = fixture(t, provider(() => new Promise(() => {})), { jobTimeoutMs: 10000 });
  runtime.start(); const task = runtime.submit({ intent: 'Deadline', policy: 'deep', maxDurationMs: 100 });
  await until(() => runtime.get(task.id).state === 'paused');
  assert.match(runtime.get(task.id).stopReason!, /deadline/);
  assert.equal(runtime.jobs(task.id)[0]?.state, 'queued');
});
