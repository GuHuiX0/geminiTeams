import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeaseManager, fileTools } from '../src/index.js';
import { delay, until } from './helpers.js';

test('leases serialize overlapping writes and allow disjoint resources', async () => {
  const leases = new LeaseManager(); const signal = new AbortController().signal;
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let child = false, sibling = false;
  const parent = leases.run(['repo/auth'], true, signal, () => gate);
  const childOp = leases.run(['repo/auth/session'], false, signal, async () => { child = true; });
  const siblingOp = leases.run(['repo/payments'], true, signal, async () => { sibling = true; });
  await until(() => sibling); assert.equal(child, false); release();
  await Promise.all([parent, childOp, siblingOp]); assert.equal(child, true);
});

test('readers can run concurrently; cancelled lease waiter never enters', async () => {
  const leases = new LeaseManager(); const signal = new AbortController().signal; const abort = new AbortController();
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let readers = 0;
  const a = leases.run(['resource'], false, signal, async () => { readers++; await gate; });
  const b = leases.run(['resource'], false, signal, async () => { readers++; await gate; });
  await until(() => readers === 2);
  const writer = leases.run(['resource'], true, abort.signal, async () => { assert.fail('Cancelled write entered'); });
  abort.abort(new Error('cancel')); await assert.rejects(writer, /cancel/); release(); await Promise.all([a, b]);
});

test('filesystem tools enforce authorization, boundaries, and atomic replacement', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'living-files-')); const root = join(dir, 'root'); mkdirSync(root);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'outside'), 'private'); writeFileSync(join(root, 'notes.txt'), 'before');
  symlinkSync(join(dir, 'outside'), join(root, 'escape')); symlinkSync(dir, join(root, 'escape-dir'));
  const tools = fileTools(root, true); const context = { taskId: 'task', jobId: 'job', idempotencyKey: 'job', signal: new AbortController().signal };
  const input = (path: string, content = 'after') => JSON.stringify({ path, content });
  await assert.rejects(tools.execute('file_write', input('notes.txt'), [], context), /not authorized/);
  await tools.execute('file_write', input('notes.txt'), ['file_write'], context);
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'after');
  for (const path of ['../outside', 'escape', 'escape-dir/outside']) {
    await assert.rejects(tools.execute('file_read', JSON.stringify({ path }), ['file_read'], context), /escapes/);
    await assert.rejects(tools.execute('file_write', input(path), ['file_write'], context), /escapes/);
  }
  assert.equal(readFileSync(join(dir, 'outside'), 'utf8'), 'private');
  assert.equal(fileTools(root).effect('file_write'), undefined);
  await delay(1);
});
