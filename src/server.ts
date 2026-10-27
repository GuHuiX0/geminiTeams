import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
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
    // Browser pages cannot use a local runtime through ambient cookies or CORS.
    if (req.headers.origin) { json(res, 403, { error: 'Browser origins are not accepted by this headless API.' }); return; }
    if (token && !authorized(req.headers.authorization, token)) { json(res, 401, { error: 'Bearer token required' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, tasks: runtime.list().length, config: runtime.config }); return;
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
        json(res, 200, { task: runtime.get(id), artifacts: runtime.artifacts(id), jobs: runtime.jobs(id),
          memory: runtime.store.all('memory').filter(m => m.taskId === id) }); return;
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
