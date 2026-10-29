import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { serve } from '../src/index.js';
import { answer, fixture, provider, until } from './helpers.js';

test('HTTP API authenticates, validates task inputs, and returns progressive results', async t => {
  const { runtime } = fixture(t, provider(() => answer())); runtime.start();
  const server = await serve(runtime, { port: 0, token: 'local-test-token' });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer local-test-token', 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/tasks')).status, 401);
  assert.equal((await fetch(base + '/health', { headers: { ...headers, origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(base + '/tasks', { method: 'POST', headers, body: '{"intent":""}' })).status, 400);
  const response = await fetch(base + '/tasks', { method: 'POST', headers, body: JSON.stringify({ intent: 'Test API', policy: 'instant' }) });
  assert.equal(response.status, 202); const task = await response.json() as { id: string };
  await until(() => runtime.get(task.id).state === 'completed');
  const get = await fetch(base + '/tasks/' + task.id, { headers });
  const result = await get.json() as { artifacts: { body: string }[] }; assert.equal(result.artifacts[0]?.body, 'A useful answer');
  assert.equal((await fetch(base + '/tasks/missing', { headers })).status, 404);
  assert.equal((await fetch(base + '/tasks/' + task.id + '/pause', { method: 'POST', headers, body: '{}' })).status, 409);
});

test('SSE replays more than one page and resumes strictly after Last-Event-ID', async t => {
  const { runtime, store } = fixture(t, provider(() => answer())); runtime.start();
  const task = runtime.submit({ intent: 'Replay task', policy: 'instant' });
  await until(() => runtime.get(task.id).state === 'completed');
  for (let i = 0; i < 1005; i++) store.append(task.id, 'test.event', { index: i });
  const server = await serve(runtime, { port: 0 });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  const response = await fetch(`${base}/events?taskId=${task.id}`, { signal: controller.signal });
  const reader = response.body!.getReader(); let text = '';
  while (!text.includes('"index":1004')) text += new TextDecoder().decode((await reader.read()).value);
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
  assert.ok(ids.length > 1000); assert.ok(ids.every((id, i) => !i || id > ids[i - 1]!));
  const cursor = ids.at(-1)!; controller.abort();
  const next = store.append(task.id, 'test.live', { value: 'next' });
  const reconnect = new AbortController();
  const resumed = await fetch(`${base}/events?taskId=${task.id}`, { headers: { 'last-event-id': String(cursor) }, signal: reconnect.signal });
  const chunk = new TextDecoder().decode((await resumed.body!.getReader().read()).value);
  assert.match(chunk, new RegExp(`^id: ${next.seq}\\n`)); reconnect.abort();
});

test('binding on all interfaces requires explicit API authentication', async t => {
  const { runtime } = fixture(t, provider(() => answer()));
  await assert.rejects(serve(runtime, { host: '0.0.0.0', port: 0 }), /bearer token/);
});

test('panel is served locally; API accepts same-origin requests and rejects DNS rebinding', async t => {
  const { runtime } = fixture(t, provider(() => answer())); runtime.start();
  const server = await serve(runtime, { port: 0, token: 'panel-secret' });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /Task workspace/);
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);
  assert.equal((await fetch(base + '/snapshot')).status, 401);
  const headers = { authorization: 'Bearer panel-secret', origin: base, 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/tasks', { method: 'POST', headers, body: JSON.stringify({ intent: 'Browser task' }) })).status, 202);
  const snapshot = await fetch(base + '/snapshot', { headers }); assert.equal(snapshot.status, 200);
  const value = await snapshot.json() as { cursor: number; tasks: unknown[] }; assert.ok(value.cursor > 0); assert.equal(value.tasks.length, 1);
  const rebinding = await fetch(base + '/health', { headers: { authorization: 'Bearer panel-secret', host: 'attacker.example', origin: 'http://attacker.example' } });
  assert.equal(rebinding.status, 403);
});

test('history pagination returns older events without gaps or duplicated boundaries', async t => {
  const { runtime, store } = fixture(t, provider(() => answer())); runtime.start();
  const task = runtime.submit({ intent: 'History task' }); await until(() => runtime.get(task.id).state === 'completed');
  const server = await serve(runtime, { port: 0 }); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const latest = await (await fetch(`${base}/history?taskId=${task.id}&limit=3`)).json() as { events: { seq: number }[]; hasMore: boolean };
  assert.equal(latest.events.length, 3); assert.equal(latest.hasMore, true);
  const older = await (await fetch(`${base}/history?taskId=${task.id}&before=${latest.events[0]!.seq}&limit=100`)).json() as { events: { seq: number }[] };
  assert.deepEqual([...older.events, ...latest.events].map(e => e.seq), store.events(0, task.id).map(e => e.seq));
});
