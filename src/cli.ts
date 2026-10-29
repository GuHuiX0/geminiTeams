#!/usr/bin/env node
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider, GeminiProvider } from './providers.js';
import { ToolRegistry, fileTools } from './tools.js';
import { serve } from './server.js';
import type { Policy, Task } from './types.js';

const stringOptions = ['db', 'model', 'host', 'port', 'url', 'token', 'policy', 'priority', 'max-calls',
  'max-parallel', 'duration-ms', 'interactive-slots', 'background-slots', 'workers-per-task', 'debounce-ms',
  'timeout-ms', 'workspace', 'tools', 'extra-calls', 'after', 'source', 'subject', 'type', 'payload',
  'event-id', 'origin', 'causation', 'in', 'every', 'key', 'value'];
const options = Object.fromEntries(stringOptions.map(name => [name, { type: 'string' as const }]));
const help = `living — latency-first agent runtime (Node 24+)

  living serve [--demo] [--db .living/runtime.sqlite] [--model MODEL]
               [--interactive-slots 2] [--background-slots 8]
               [--workspace DIR] [--allow-writes] [--ground-search] [--port 7331]
  living submit "goal" [--policy instant|focused|deep|persistent] [--wait]
                [--max-calls N] [--max-parallel N] [--tools file_read,file_write]
  living list | get TASK_ID
  living pause | resume | cancel TASK_ID [--extra-calls N]
  living steer TASK_ID "revised complete intent"
  living events [TASK_ID] [--after SEQ]
  living subscribe TASK_ID --source SOURCE [--subject 'prefix*'] [--type TYPE]
  living emit --source SOURCE --subject SUBJECT --type TYPE [--payload '{"key":"value"}']
  living timer TASK_ID --in 10s [--every 1h]
  living unsubscribe | untimer ID
  living remember TASK_ID --key KEY --value TEXT
  living reconcile JOB_ID "observed outcome of interrupted write"

Clients use --url (LIVING_URL) and --token (LIVING_TOKEN).
Set GEMINI_API_KEY for real inference. --demo uses scripted, labeled offline responses.
`;
function duration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2] ?? 'ms'] ?? 1);
}
async function main(): Promise<void> {
  const args = parseArgs({ options: { ...options, demo: { type: 'boolean' }, wait: { type: 'boolean' },
    'allow-writes': { type: 'boolean' }, 'ground-search': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  const values = args.values as Record<string, string | boolean | undefined>; const [command, ...rest] = args.positionals;
  const value = (name: string, fallback?: string) => {
    const found = values[name]; return typeof found === 'string' ? found : fallback;
  };
  const numeric = (name: string, fallback: number) => Number(value(name) ?? fallback);
  const required = (name: string) => { const found = value(name); if (!found) throw new Error(`--${name} is required`); return found; };
  const id = () => { if (!rest[0]) throw new Error('Task/job ID is required'); return encodeURIComponent(rest[0]); };
  if (!command || values.help) { console.log(help); return; }
  const token = value('token', process.env.LIVING_TOKEN);
  if (command === 'serve') {
    const store = new Store(value('db', process.env.LIVING_DB) ?? '.living/runtime.sqlite');
    const workspace = value('workspace');
    if (values['allow-writes'] && !workspace) throw new Error('--allow-writes requires --workspace');
    const tools = workspace ? fileTools(workspace, values['allow-writes'] === true) : new ToolRegistry();
    const model = value('model');
    const runtime = new Runtime(store, values.demo ? new DemoProvider({ chunkDelayMs: 35 }) : new GeminiProvider({ ...(model ? { model } : {}), search: values['ground-search'] === true }), {
      interactiveSlots: numeric('interactive-slots', 2), backgroundSlots: numeric('background-slots', 8),
      maxWorkersPerTask: numeric('workers-per-task', 4), debounceMs: numeric('debounce-ms', 500),
      jobTimeoutMs: numeric('timeout-ms', 120000),
    }, tools);
    runtime.start();
    let server;
    try {
      server = await serve(runtime, { host: value('host', '127.0.0.1')!, port: numeric('port', 7331), ...(token ? { token } : {}) });
    } catch (error) { await runtime.stop(); store.close(); throw error; }
    const bound = server.address() as AddressInfo;
    console.log(`Living runtime listening on ${bound.address}:${bound.port}${values.demo ? ' [OFFLINE DEMO]' : ''}`);
    console.log(`Open the panel: http://${bound.address.includes(':') ? '[' + bound.address + ']' : bound.address}:${bound.port}`);
    let closing = false;
    const shutdown = async () => {
      if (closing) return; closing = true;
      server.close(); server.closeAllConnections(); await runtime.stop(); store.close();
    };
    process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
    return;
  }
  const base = value('url', process.env.LIVING_URL) ?? 'http://127.0.0.1:7331';
  async function request(path: string, input?: unknown, method = input === undefined ? 'GET' : 'POST'): Promise<unknown> {
    const response = await fetch(new URL(path, base), { method,
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(input !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(30000), });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
    return data;
  }
  let result: unknown;
  switch (command) {
    case 'submit': {
      const intent = rest.join(' '); if (!intent) throw new Error('Task intent is required');
      const input = { intent, policy: value('policy', 'focused') as Policy, priority: numeric('priority', 5),
        maxParallel: numeric('max-parallel', 3), maxDurationMs: numeric('duration-ms', 1800000),
        allowedTools: value('tools')?.split(',').filter(Boolean) ?? [],
        ...(value('max-calls') ? { maxCalls: numeric('max-calls', 10) } : {}) };
      const task = await request('/tasks', input) as Task; result = task;
      if (values.wait) {
        console.log(`Task ${task.id}`); let latest: string | null = null;
        for (;;) {
          const snapshot = await request('/tasks/' + task.id) as { task: Task; artifacts: { id: string; body: string }[] };
          if (snapshot.task.latestArtifactId && snapshot.task.latestArtifactId !== latest) {
            latest = snapshot.task.latestArtifactId;
            console.log(snapshot.artifacts.find(a => a.id === latest)?.body ?? '');
          }
          if (snapshot.task.state !== 'active') {
            console.log(`[${snapshot.task.state}] ${snapshot.task.stopReason ?? ''}`);
            if (snapshot.task.state === 'failed') process.exitCode = 1;
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      break;
    }
    case 'list': result = await request('/tasks'); break;
    case 'get': result = await request('/tasks/' + id()); break;
    case 'pause': case 'cancel': result = await request(`/tasks/${id()}/${command}`, {}); break;
    case 'resume': result = await request(`/tasks/${id()}/resume`, { extraCalls: numeric('extra-calls', 0) }); break;
    case 'steer': result = await request(`/tasks/${id()}/steer`, { intent: rest.slice(1).join(' ') }); break;
    case 'remember': result = await request(`/tasks/${id()}/memory`, { key: required('key'), value: required('value') }); break;
    case 'reconcile': result = await request(`/jobs/${id()}/reconcile`, { result: rest.slice(1).join(' ') }); break;
    case 'subscribe': result = await request(`/tasks/${id()}/subscriptions`, {
      source: required('source'), subject: value('subject', '*'), type: value('type', '*') }); break;
    case 'unsubscribe': case 'untimer': result = await request(`/${command === 'untimer' ? 'timers' : 'subscriptions'}/${id()}`, undefined, 'DELETE'); break;
    case 'emit': result = await request('/ingest', { source: required('source'), subject: required('subject'), type: required('type'),
      payload: JSON.parse(value('payload', '{}')!), ...(value('event-id') ? { id: value('event-id') } : {}),
      ...(value('origin') ? { originTaskId: value('origin') } : {}), causation: JSON.parse(value('causation', '[]')!) }); break;
    case 'timer': result = await request(`/tasks/${id()}/timers`, { dueAt: Date.now() + duration(required('in')),
      ...(value('every') ? { intervalMs: duration(required('every')) } : {}) }); break;
    case 'events': {
      const url = new URL('/events', base); if (rest[0]) url.searchParams.set('taskId', rest[0]);
      url.searchParams.set('after', value('after', '0')!);
      const response = await fetch(url, { headers: token ? { authorization: 'Bearer ' + token } : {} });
      if (!response.ok || !response.body) throw new Error(`Event stream failed: ${response.status}`);
      for await (const chunk of response.body) process.stdout.write(chunk);
      return;
    }
    default: throw new Error(`Unknown command: ${command}\n${help}`);
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
