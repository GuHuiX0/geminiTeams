import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, Store, DemoProvider, serve } from '../src/index.js';
import type { ModelProvider } from '../src/index.js';
import { abortableDelay } from '../src/tools.js';
import { answer, until } from './helpers.js';
let browser: Browser;
test.before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
test.after(async () => { await browser?.close(); });
async function rig(t: TestContext, model: ModelProvider = new DemoProvider({ chunkDelayMs: 45 }), token?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'living-panel-')); const store = new Store(join(directory, 'state.sqlite'));
  const runtime = new Runtime(store, model, { tickMs: 5 }).start();
  const server = await serve(runtime, { port: 0, ...(token ? { token } : {}) });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await browser.newContext({ viewport: { width: 1536, height: 1000 } }); const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(7000);
  t.after(async () => { await context.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { runtime, store, page, base, server, errors };
}
async function ready(page: Page, base: string) { await page.goto(base); await page.locator('#connection-label').getByText('Connected', { exact: true }).waitFor(); }
async function screenshot(page: Page, name: string) { mkdirSync('.panel-test-artifacts', { recursive: true }); await page.screenshot({ path: `.panel-test-artifacts/${name}.png`, fullPage: true }); }

test('create → live response → recorded result → causal step inspection', { timeout: 20000 }, async t => {
  const { runtime, store, page, base, errors } = await rig(t, new DemoProvider({ chunkDelayMs: 90 }));
  await ready(page, base); await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.locator('#task-intent').fill('Compare possible architectures for a research runtime');
  await page.locator('#task-policy').selectOption('deep'); await page.locator('#task-form button[type=submit]').click();
  await page.locator('.live-output').first().getByText('[OFFLINE DEMO]', { exact: false }).first().waitFor();
  const task = runtime.list()[0]!; assert.equal(task.state, 'active');
  await screenshot(page, 'streaming-response');
  await page.locator('[data-view="execution"]').first().click();
  await page.locator('[data-node]').first().click();
  await page.getByRole('complementary', { name: 'Selected step details' }).waitFor();
  assert.match(await page.locator('#inspector').textContent() ?? '', /Task intent at this step/);
  await until(() => runtime.get(task.id).state === 'completed', 7000);
  await page.locator('[data-view="results"]').first().click();
  await page.locator('.result-detail-heading h2').getByText('Synthesis', { exact: false }).waitFor();
  assert.equal(await page.locator('#artifact-select option').count(), 2);
  await page.locator('[data-view="execution"]').first().click();
  const finalJob = runtime.jobs(task.id).at(-1)!;
  await page.locator(`[data-node="${finalJob.id}"]`).click();
  await page.locator('#inspector h2').getByText('Synthesis', { exact: true }).waitFor();
  await page.locator('#inspector').getByText('Inputs available to this call', { exact: true }).waitFor();
  assert.ok(await page.locator('#inspector .context-reference').count() >= 3);
  await screenshot(page, 'execution-inspection');
  const historicalEvent = store.events(0, task.id).find(event => event.kind === 'task.created')!;
  store.transaction(() => { for (let i = 0; i < 350; i++) store.append(task.id, 'test.audit', { index: i }); });
  await page.goto(base + '/#task=' + task.id + '&view=activity&event=' + historicalEvent.seq);
  await page.reload();
  await page.locator('#inspector h2').getByText('Task started', { exact: true }).waitFor();
  store.append(task.id, 'test.after_refresh', { marker: 'arrived after reload' });
  await page.getByRole('button', { name: /test · after refresh/ }).waitFor();
  assert.match(await page.locator('#inspector h2').textContent() ?? '', /Task started/);
  assert.deepEqual(errors, []);
});

test('diagnose failed synthesis and retry it without rerunning completed workers', { timeout: 20000 }, async t => {
  const { runtime, page, base, errors } = await rig(t, new DemoProvider({ chunkDelayMs: 12 }));
  await ready(page, base); await page.getByRole('button', { name: 'Try a recovery scenario', exact: false }).click();
  await until(() => runtime.list().some(task => task.state === 'failed'), 7000);
  const task = runtime.list().find(task => task.state === 'failed')!;
  const workers = runtime.jobs(task.id).filter(j => j.kind === 'reason');
  await page.locator('.notice button[data-job]').click();
  await page.getByRole('button', { name: 'Retry this step', exact: false }).click();
  await page.locator('#action-submit').click();
  await until(() => runtime.get(task.id).state === 'completed', 7000);
  for (const job of workers) assert.equal(runtime.jobs(task.id).find(j => j.id === job.id)!.attempts, job.attempts);
  await page.locator('[data-view="activity"]').first().click(); await page.locator('#event-filter').selectOption('control');
  await page.getByRole('button', { name: /Step retried by user/ }).waitFor();
  await screenshot(page, 'recovered-task'); assert.deepEqual(errors, []);
});

test('pause, resume, redirect, and cancel operate on the selected task and preserve prior attempts', { timeout: 20000 }, async t => {
  const model: ModelProvider = { execute: async (request, signal, onText) => { onText?.('Draft response for: ' + request.task.intent); await abortableDelay(12000, signal); return answer(); } };
  const { runtime, page, base, errors } = await rig(t, model);
  const task = runtime.submit({ intent: 'An initial goal', policy: 'deep' });
  await page.goto(base + '/#task=' + task.id); await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pause', exact: true }).click(); await page.locator('#action-submit').click();
  await until(() => runtime.get(task.id).state === 'paused');
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); await page.locator('#action-submit').click();
  await until(() => runtime.get(task.id).state === 'active');
  await page.getByRole('button', { name: 'Redirect', exact: true }).click();
  await page.locator('#revised-intent').fill('A revised goal with preserved context'); await page.locator('#action-submit').click();
  await until(() => runtime.get(task.id).revision === 2);
  await page.getByRole('heading', { name: 'A revised goal with preserved context', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click(); await page.locator('#action-submit').click();
  await until(() => runtime.get(task.id).state === 'cancelled');
  assert.equal(runtime.jobs(task.id).filter(j => j.revision === 1).length, 1); assert.deepEqual(errors, []);
});

test('token access, response sanitization, reload persistence, and event-stream reconnect', { timeout: 20000 }, async t => {
  const { runtime, page, base, server, errors } = await rig(t, { execute: async (_, __, onText) => {
    onText?.('A response'); return answer('A safe result <img src=x onerror="window.panelCompromised=true"> [bad](javascript:alert(1))');
  } }, 'e2e-local-token');
  await page.goto(base); await page.getByRole('heading', { name: 'Connect to your runtime', exact: true }).waitFor();
  await page.locator('#runtime-token').fill('wrong'); await page.locator('#connection-form button[type=submit]').click();
  await page.locator('#connection-error').getByText('Bearer token required', { exact: false }).waitFor();
  await page.locator('#runtime-token').fill('e2e-local-token'); await page.locator('#connection-form button[type=submit]').click();
  await page.locator('#connection-dialog').waitFor({ state: 'hidden' });
  const task = runtime.submit({ intent: 'Inspect a safe result', policy: 'instant' });
  await until(() => runtime.get(task.id).state === 'completed');
  await page.goto(base + '/#task=' + task.id + '&view=results'); await page.locator('.full-result').waitFor();
  assert.equal(await page.locator('.full-result img').count(), 0);
  assert.equal(await page.locator('.full-result a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => (window as unknown as { panelCompromised?: boolean }).panelCompromised), undefined);
  await page.reload(); await page.locator('.full-result').waitFor(); assert.equal(page.url().includes('e2e-local-token'), false);
  server.closeAllConnections(); await page.locator('#connection-label').getByText('Connected', { exact: true }).waitFor();
  const next = runtime.submit({ intent: 'Arrived after reconnect', policy: 'instant' });
  await page.locator(`#task-list [data-task="${next.id}"]`).waitFor(); assert.deepEqual(errors, []);
});

test('mobile task navigation, step inspection, and dialogs fit a narrow viewport', { timeout: 20000 }, async t => {
  const { runtime, page, base, errors } = await rig(t, new DemoProvider({ chunkDelayMs: 1 }));
  const task = runtime.submit({ intent: 'A mobile task with a longer description', policy: 'deep' });
  const other = runtime.submit({ intent: 'Another task', policy: 'instant' });
  await until(() => runtime.get(task.id).state === 'completed');
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(base + '/#task=' + task.id + '&view=execution');
  await page.locator('[data-node]').first().click();
  await page.locator('#inspector').waitFor();
  assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
  await screenshot(page, 'mobile-inspection'); await page.keyboard.press('Escape'); await page.locator('#inspector').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Toggle task navigation' }).click();
  await page.locator(`#task-list [data-task="${other.id}"]`).click();
  await page.locator('.task-heading h1').getByText('Another task', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New task', exact: true }).click(); await page.locator('#task-dialog').waitFor();
  const box = await page.locator('#task-dialog').boundingBox(); assert.ok(box && box.width <= 390);
  assert.deepEqual(errors, []);
});
