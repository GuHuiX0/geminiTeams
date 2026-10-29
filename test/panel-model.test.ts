import test from 'node:test';
import assert from 'node:assert/strict';
import { layers, retryBlocker, taskSummary, filterEvents, parseRoute, sseParser } from '../web/model.js';
import type { RuntimeEvent } from '../src/index.js';
import { fixture, provider, answer } from './helpers.js';

test('execution presentation follows actual dependency joins, including historical step selection', t => {
  const { runtime } = fixture(t, provider(() => answer()));
  const task = runtime.submit({ intent: 'Understand execution' }); const root = runtime.jobs(task.id)[0]!;
  const a = { ...root, id: 'a', parentId: root.id, kind: 'reason' as const };
  const b = { ...root, id: 'b', parentId: root.id, kind: 'reason' as const };
  const join = { ...root, id: 'join', parentId: root.id, dependsOn: ['a', 'b'] };
  assert.deepEqual(layers([root, a, b, join]).map((group: typeof root[]) => group.map(j => j.id)), [[root.id], ['a', 'b'], ['join']]);
  assert.equal(taskSummary(task, [root, a, b, join]).blocked.length, 1);
  assert.deepEqual(parseRoute('#task=task&view=execution&step=a&revision=1'), { taskId: 'task', view: 'execution', jobId: 'a', artifactId: null, eventId: null, revision: '1' });
});

test('retry affordance explains when downstream results prevent selective replay', t => {
  const { runtime } = fixture(t, provider(() => answer())); const task = runtime.submit({ intent: 'Retry' });
  const failed = { ...runtime.jobs(task.id)[0]!, state: 'failed' as const };
  const downstream = { ...failed, id: 'next', state: 'completed' as const, dependsOn: [failed.id] };
  assert.equal(retryBlocker(failed, [failed], task), '');
  assert.match(retryBlocker(failed, [failed, downstream], task), /Dependent work has already run/);
});

test('trace filters distinguish control, failures, decisions, and high-volume response text', () => {
  const events: RuntimeEvent[] = ['job.output', 'job.failed', 'decision.recorded', 'task.steered'].map((kind, i) => ({ seq: i + 1, taskId: 't', kind, data: {}, createdAt: 0 }));
  assert.equal(filterEvents(events, 'all').length, 3);
  assert.deepEqual(filterEvents(events, 'control').map((e: RuntimeEvent) => e.kind), ['task.steered']);
  assert.deepEqual(filterEvents(events, 'failures').map((e: RuntimeEvent) => e.kind), ['job.failed']);
});

test('SSE parser preserves split data records and reconnect cursors', () => {
  const events: RuntimeEvent[] = []; const push = sseParser((event: RuntimeEvent) => events.push(event));
  const record = 'id: 21\r\nevent: job.output\r\ndata: {"seq":21,"data":{"text":"hello 中文"}}\r\n\r\n';
  for (const character of record) push(character);
  push(': heartbeat\n\n'); assert.equal(events.length, 1); assert.equal(events[0]?.seq, 21);
});
