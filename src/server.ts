import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { panelAsset } from './panel.js';
import { DemoProvider, GeminiProvider } from './providers.js';
import { Runtime } from './runtime.js';
import { ConflictError, NotFoundError } from './types.js';

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 65536) throw new Error('Request body exceeds 64 KiB');
    chunks.push(Buffer.from(chunk));
  }
  return size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
const fields = z.record(z.string(), z.unknown());
const text = (value: unknown) => z.string().min(1).parse(value);
const number = (value: unknown) => z.number().finite().parse(value);
function authorized(header: string | undefined, token: string): boolean {
  const value = Buffer.from(header ?? ''); const expected = Buffer.from('Bearer ' + token);
  return value.length === expected.length && timingSafeEqual(value, expected);
}
export interface ServerOptions { host?: string; port?: number; token?: string }
export async function serve(runtime: Runtime, options: ServerOptions = {}): Promise<Server> {
  const host = options.host ?? '127.0.0.1'; const token = options.token;
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token) throw new Error('A bearer token is required for a non-loopback bind.');
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof NotFoundError ? 404 : error instanceof ConflictError ? 409 : 400;
      json(res, status, { error: error instanceof Error ? error.message : 'Request failed' });
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    let requestHost: URL;
    try { requestHost = new URL('http://' + req.headers.host); } catch { json(res, 403, { error: 'Invalid host' }); return; }
    if (['127.0.0.1', '::1', 'localhost'].includes(host) && !['127.0.0.1', '[::1]', 'localhost'].includes(requestHost.hostname)) {
      json(res, 403, { error: 'Local runtime requires a loopback host' }); return;
    }
    if (req.headers.origin && req.headers.origin !== requestHost.origin) {
      json(res, 403, { error: 'Cross-origin requests are not accepted.' }); return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';
    // Public assets contain no task data; API access still requires the configured token.
    if (method === 'GET' && panelAsset(url.pathname, res)) return;
    if (token && !authorized(req.headers.authorization, token)) { json(res, 401, { error: 'Bearer token required' }); return; }
    const taskDetail = (id: string) => ({ task: runtime.get(id), artifacts: runtime.artifacts(id), jobs: runtime.jobs(id),
      memory: runtime.store.all('memory').filter(m => m.taskId === id),
      subscriptions: runtime.store.all('subscriptions').filter(s => s.taskId === id),
      timers: runtime.store.all('timers').filter(t => t.taskId === id) });
    if (method === 'GET' && url.pathname === '/snapshot') {
      const taskId = url.searchParams.get('taskId');
      json(res, 200, { cursor: runtime.store.cursor(), tasks: runtime.list(),
        jobs: runtime.store.all('jobs').map(({ result, output, basedOn, inputJson, ...summary }) => summary),
        selected: taskId ? taskDetail(taskId) : null,
        events: runtime.store.history(taskId ?? undefined, Number.MAX_SAFE_INTEGER, 300),
        config: runtime.config, demo: runtime.provider instanceof DemoProvider,
        model: runtime.provider instanceof GeminiProvider ? runtime.provider.model : runtime.provider instanceof DemoProvider ? 'Offline demo' : 'Custom provider' }); return;
    }
    if (method === 'GET' && url.pathname === '/history') {
      const taskId = url.searchParams.get('taskId') ?? undefined;
      if (taskId) runtime.get(taskId);
      const before = z.coerce.number().int().nonnegative().parse(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      const limit = z.coerce.number().int().min(1).max(1000).parse(url.searchParams.get('limit') ?? 300);
      const events = runtime.store.history(taskId, before, limit + 1);
      json(res, 200, { events: events.slice(-limit), hasMore: events.length > limit }); return;
    }
    if (method === 'POST' && url.pathname === '/demo/scenario') {
      if (!(runtime.provider instanceof DemoProvider)) throw new ConflictError('Demo scenarios require --demo mode.');
      const input = fields.parse(await body(req));
      const task = runtime.submit({ intent: 'Compare architectures for a persistent research assistant', policy: 'deep' });
      if (input.debug === true) runtime.provider.failNextSynthesis(task.id, runtime.config.maxAttempts);
      const quick = runtime.submit({ intent: 'Summarize the constraints for an always-on agent', policy: 'instant' });
      const persistent = runtime.submit({ intent: 'Track evidence for an event-driven agent runtime', policy: 'persistent' });
      json(res, 202, { taskId: task.id, taskIds: [task.id, quick.id, persistent.id] }); return;
    }
    if (method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, tasks: runtime.list().length, config: runtime.config, panel: true, demo: runtime.provider instanceof DemoProvider }); return;
    }
    if (method === 'GET' && url.pathname === '/events') {
      const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
      z.number().int().nonnegative().parse(after);
      const taskId = url.searchParams.get('taskId') ?? undefined;
      if (taskId) runtime.get(taskId);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      let cursor = after;
      const send = (event: ReturnType<Runtime['store']['events']>[number]) => {
        if (event.seq <= cursor || (taskId && event.taskId !== taskId) || res.destroyed) return;
        res.write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.seq;
        if (res.writableLength > 1048576) res.destroy(); // Client reconnects using the last received cursor.
      };
      // Replay and subscribe in one synchronous turn, so no event can fall in between.
      let batch;
      do { batch = runtime.store.events(cursor, taskId, 1000); for (const event of batch) send(event); }
      while (batch.length === 1000 && !res.destroyed);
      const remove = runtime.store.onEvent(send);
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
      res.on('close', () => { clearInterval(heartbeat); remove(); });
      return;
    }
    if (method === 'GET' && path.length === 1 && path[0] === 'tasks') { json(res, 200, runtime.list()); return; }
    if (method === 'POST' && url.pathname === '/tasks') {
      const task = runtime.submit(await body(req) as Parameters<Runtime['submit']>[0]);
      json(res, 202, task); return;
    }
    if (method === 'POST' && url.pathname === '/ingest') { json(res, 202, runtime.ingest(await body(req) as Parameters<Runtime['ingest']>[0])); return; }
    if (path[0] === 'tasks' && path[1]) {
      const id = path[1]; const action = path[2];
      if (method === 'GET' && !action) {
        json(res, 200, taskDetail(id)); return;
      }
      if (method === 'POST') {
        const input = fields.parse(await body(req)); let result: unknown;
        switch (action) {
          case 'pause': result = runtime.pause(id); break;
          case 'resume': result = runtime.resume(id, input.extraCalls === undefined ? 0 : number(input.extraCalls)); break;
          case 'cancel': result = runtime.cancel(id); break;
          case 'steer': result = runtime.steer(id, text(input.intent)); break;
          case 'memory': runtime.remember(id, text(input.key), text(input.value), input.source === undefined ? 'user' : text(input.source)); result = { ok: true }; break;
          case 'subscriptions': result = { id: runtime.subscribe(id, text(input.source), input.subject === undefined ? '*' : text(input.subject), input.type === undefined ? '*' : text(input.type)) }; break;
          case 'timers': result = { id: runtime.timer(id, number(input.dueAt), input.intervalMs === undefined ? null : number(input.intervalMs)) }; break;
          default: json(res, 404, { error: 'Unknown task action' }); return;
        }
        json(res, 200, result); return;
      }
    }
    if (method === 'DELETE' && ['subscriptions', 'timers'].includes(path[0] ?? '') && path[1]) {
      const table = path[0] as 'subscriptions' | 'timers'; runtime.store.require(table, path[1]);
      runtime.store.remove(table, path[1]); json(res, 200, { ok: true }); return;
    }
    if (method === 'POST' && path[0] === 'jobs' && path[1] && path[2] === 'retry') {
      const input = fields.parse(await body(req));
      json(res, 200, runtime.retryJob(path[1], input.extraCalls === undefined ? 0 : number(input.extraCalls))); return;
    }
    if (method === 'POST' && path[0] === 'jobs' && path[1] && path[2] === 'reconcile') {
      const input = fields.parse(await body(req)); runtime.reconcile(path[1], text(input.result)); json(res, 200, { ok: true }); return;
    }
    json(res, 404, { error: 'Route not found' });
  }
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject); server.listen(options.port ?? 7331, host, () => { server.off('error', reject); resolveListen(); });
  });
  return server;
}
