import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactTextDecoder } from '../src/streaming.js';
import { fixture, answer, branch, provider, until, delay } from './helpers.js';

test('structured response text decodes across every character boundary without exposing protocol JSON', () => {
  const body = 'A "quoted" answer\nwith a slash \\ and Unicode: 中文 🦉';
  const input = JSON.stringify({ artifact: { title: 'Result', body }, next: 'complete', operations: [], reason: 'Done' });
  const decoder = new ArtifactTextDecoder(); let output = '';
  for (const character of input) output += decoder.push(character);
  assert.equal(output, body);
  const escaped = new ArtifactTextDecoder();
  assert.equal(escaped.push('{"artifact":{"body":"A \\u4e'), 'A ');
  assert.equal(escaped.push('2d\\u6587"}}'), '中文');
});

test('response text is visible before completion and persists for reconnecting panel clients', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const { runtime, store } = fixture(t, { execute: async (_, signal, onText) => {
    onText?.('First useful text'); await gate; signal.throwIfAborted(); onText?.(' and conclusion'); return answer('First useful text and conclusion');
  } });
  runtime.start(); const task = runtime.submit({ intent: 'Stream a result', policy: 'instant' });
  await until(() => store.events(0, task.id).some(e => e.kind === 'job.output'));
  assert.equal(runtime.get(task.id).state, 'active');
  assert.equal(runtime.jobs(task.id)[0]?.output, 'First useful text');
  release(); await until(() => runtime.get(task.id).state === 'completed');
  assert.equal(runtime.jobs(task.id)[0]?.output, 'First useful text and conclusion');
});

test('late output from an interrupted revision cannot contaminate the new response', async t => {
  let emitOld: ((text: string) => void) | undefined;
  const { runtime, store } = fixture(t, { execute: async (request, _, onText) => {
    if (request.task.revision === 1) { emitOld = onText; return new Promise(() => {}); }
    onText?.('Revised response'); return answer('Revised response');
  } });
  runtime.start(); const task = runtime.submit({ intent: 'Old goal', policy: 'deep' });
  await until(() => Boolean(emitOld)); runtime.steer(task.id, 'New goal');
  await until(() => runtime.get(task.id).state === 'completed'); emitOld!('Stale output'); await delay(90);
  assert.equal(store.events(0, task.id).some(e => e.kind === 'job.output' && JSON.stringify(e.data).includes('Stale')), false);
});

test('retry of failed synthesis preserves independent completed workers and recorded input links', async t => {
  let fail = true;
  const { runtime } = fixture(t, provider(request => {
    if (request.job.kind === 'reason') return 'Independent finding';
    if (!request.artifacts.length) return branch('Explore A', 'Explore B');
    if (fail) throw new Error('Synthesis unavailable');
    return answer('Synthesis recovered');
  }), { maxAttempts: 1 });
  runtime.start(); const task = runtime.submit({ intent: 'Recover one step', policy: 'deep' });
  await until(() => runtime.get(task.id).state === 'failed');
  const failed = runtime.jobs(task.id).find(j => j.state === 'failed')!;
  const completed = runtime.jobs(task.id).filter(j => j.state === 'completed');
  assert.equal(failed.basedOn?.jobIds.length, 2);
  fail = false; runtime.retryJob(failed.id); await until(() => runtime.get(task.id).state === 'completed');
  for (const job of completed) assert.equal(runtime.jobs(task.id).find(j => j.id === job.id)?.attempts, job.attempts);
  assert.equal(runtime.artifacts(task.id).at(-1)?.body, 'Synthesis recovered');
});
