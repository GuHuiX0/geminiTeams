import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../src/index.js';
import type { ModelRequest } from '../src/index.js';
import { answer, fixture, provider } from './helpers.js';

function request(t: Parameters<typeof fixture>[0], policy: 'deep' | 'instant' = 'deep'): ModelRequest {
  const { runtime } = fixture(t, provider(() => answer())); const task = runtime.submit({ intent: 'Test Gemini protocol', policy });
  return { task, job: runtime.jobs(task.id)[0]!, artifacts: [], observations: [], memory: [], mailbox: [], tools: [] };
}
function modelResponse(text: string) {
  return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Gemini adapter sends structured controller schema through the real SDK', async t => {
  let payload: Record<string, unknown> | undefined; let networkCalls = 0;
  const gemini = new GeminiProvider({ apiKey: 'test-placeholder', model: 'test-model', fetch: async (_, init) => {
    payload = JSON.parse(init?.body as string) as Record<string, unknown>; networkCalls++;
    return modelResponse(JSON.stringify(answer('Structured output')));
  } });
  const result = await gemini.execute(request(t), new AbortController().signal);
  assert.equal(typeof result, 'object'); assert.equal(networkCalls, 1);
  const config = payload?.generationConfig as { responseMimeType: string; responseJsonSchema: unknown };
  assert.equal(config.responseMimeType, 'application/json'); assert.ok(config.responseJsonSchema);
});

test('instant Gemini path uses one plain response with no planner schema', async t => {
  let payload: Record<string, unknown> | undefined;
  const gemini = new GeminiProvider({ apiKey: 'test-placeholder', fetch: async (_, init) => {
    payload = JSON.parse(init?.body as string) as Record<string, unknown>; return modelResponse('Direct answer');
  } });
  const result = await gemini.execute(request(t, 'instant'), new AbortController().signal);
  assert.equal(typeof result === 'object' && result.artifact?.body, 'Direct answer');
  assert.equal((payload?.generationConfig as { responseMimeType?: string } | undefined)?.responseMimeType, undefined);
});

test('SDK hidden retries are disabled so runtime call accounting stays accurate', async t => {
  let calls = 0;
  const gemini = new GeminiProvider({ apiKey: 'test-placeholder', fetch: async () => {
    calls++; return new Response(JSON.stringify({ error: { code: 429, message: 'Rate limit', status: 'RESOURCE_EXHAUSTED' } }), { status: 429 });
  } });
  await assert.rejects(gemini.execute(request(t), new AbortController().signal)); assert.equal(calls, 1);
});

test('malformed structured output and truncated responses are rejected', async t => {
  const gemini = new GeminiProvider({ apiKey: 'test-placeholder', fetch: async () => modelResponse('invalid JSON') });
  await assert.rejects(gemini.execute(request(t), new AbortController().signal));
  const truncated = new GeminiProvider({ apiKey: 'test-placeholder', fetch: async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(answer()) }] }, finishReason: 'MAX_TOKENS' }],
  }), { status: 200 }) });
  await assert.rejects(truncated.execute(request(t), new AbortController().signal), /did not finish normally/);
});

test('optional search grounding is limited to workers and preserves returned source references', async t => {
  let payload: Record<string, unknown> | undefined;
  const gemini = new GeminiProvider({ apiKey: 'test-placeholder', search: true, fetch: async (_, init) => {
    payload = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Grounded finding' }] }, finishReason: 'STOP',
      groundingMetadata: { groundingChunks: [{ web: { title: 'Primary source', uri: 'https://example.com/source' } }] },
    }] }), { status: 200 });
  } });
  const input = request(t); input.job.kind = 'reason';
  const result = await gemini.execute(input, new AbortController().signal);
  assert.match(result as string, /https:\/\/example.com\/source/);
  assert.ok(payload?.tools);
});
