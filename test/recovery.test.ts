import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, Store } from '../src/index.js';
import { answer, provider, until } from './helpers.js';

test('SIGKILL releases ownership and the next process resumes the durable checkpoint', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'living-crash-')); const path = join(dir, 'state.sqlite');
  const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures/crash-worker.ts'), path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
  let output = ''; let errors = ''; child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  await until(() => output.includes('\n') || child.exitCode !== null, 5000);
  assert.equal(child.exitCode, null, errors);
  const { taskId } = JSON.parse(output.trim()) as { taskId: string };
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  const store = new Store(path); const runtime = new Runtime(store, provider(() => answer('Recovered after SIGKILL')), { tickMs: 5 }).start();
  try {
    await until(() => runtime.get(taskId).state === 'completed');
    assert.equal(runtime.artifacts(taskId).at(-1)?.body, 'Recovered after SIGKILL');
    assert.equal(runtime.get(taskId).calls, 2);
    assert.ok(store.events(0, taskId).some(e => e.kind === 'job.recovered'));
  } finally { await runtime.stop(); store.close(); }
});
