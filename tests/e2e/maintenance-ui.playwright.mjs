import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createSandboxApi } from '../../engine/sandbox-api.mjs';
import { createMaintenanceApi } from '../../engine/maintenance-api.mjs';
import { startMaintenanceFixture } from './fixtures/maintenance-server.mjs';
let fixture, browser;
before(async () => { fixture = await startMaintenanceFixture(); browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); await fixture?.server.close(); });

for (const width of [1440, 390]) test(`maintenance and sandbox real components at ${width}px`, { timeout: 120000 }, async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-maintenance-ui-'));
  const context = await browser.newContext({ viewport: { width, height: 1100 } });
  let releasePost;
  t.after(async () => { releasePost?.(); await context.close(); fs.rmSync(agentDir, { recursive: true, force: true }); });
  const sessionExists = id => ['A', 'B'].includes(id);
  const sandbox = createSandboxApi({ agentDir, sessionExists });
  const maintenance = createMaintenanceApi({ sessionExists });
  const errors = [], unexpected = [], writes = [];
  let failGet = false, failMaintenance = false, pausePost = false;
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== fixture.origin) { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let result;
    if (url.pathname === '/api/models') result = { status: 200, body: { models: [] } };
    else if (url.pathname === '/api/sessions') result = { status: 200, body: { sessions: [] } };
    else if (url.pathname === '/api/sandbox/mode') {
      if (req.method() === 'POST') {
        const body = req.postDataJSON(); writes.push(body);
        if (pausePost) await new Promise(resolve => { releasePost = resolve; });
        result = sandbox.set(body);
      } else result = failGet ? { status: 503, body: { error: 'fixture offline' } } : sandbox.get(url.searchParams.get('session'));
    } else if (url.pathname === '/api/maintenance/status') result = failMaintenance ? { status: 503, body: { error: 'fixture offline' } } : maintenance.status(url.searchParams.get('session'));
    else { unexpected.push(url.pathname); return route.abort(); }
    await route.fulfill({ status: result.status, json: result.body });
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(fixture.origin + '/__maintenance');
  await page.getByText('请先选择一个会话', { exact: false }).waitFor();
  const select = page.getByLabel('测试会话');
  await select.selectOption('A');
  await page.getByText('默认授权 1 小时，单次最长 2 小时。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '不可启用 · 执行器待接入', exact: true }).isDisabled(), true);
  pausePost = true;
  await page.getByRole('button', { name: '只看不改', exact: false }).click();
  await page.getByText('正在保存本会话设置…', { exact: true }).waitFor();
  assert.equal(await page.locator('#sandbox-mode-title').locator('..').getByRole('button', { disabled: true }).count(), 3);
  await select.selectOption('B');
  await page.getByText('目标会话：B', { exact: true }).waitFor();
  releasePost(); pausePost = false;
  await page.getByRole('button', { name: '标准 · 当前', exact: false }).waitFor();
  assert.equal(sandbox.get('B').body.preset, 'standard');
  assert.equal(writes.length, 1); assert.equal(writes[0].sessionId, 'A');
  await select.selectOption('');
  failGet = true; failMaintenance = true;
  // Fresh page prevents cached successful views from masking initial failure.
  await page.reload(); await select.selectOption('B');
  await page.getByText('无法确认本会话沙箱状态，暂不可切换。', { exact: true }).waitFor();
  await page.getByText('无法确认维护能力状态，当前不可启用。', { exact: true }).waitFor();
  failGet = false; failMaintenance = false;
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.getByRole('button', { name: '重新读取维护状态', exact: true }).click();
  await page.getByText('默认授权 1 小时，单次最长 2 小时。', { exact: true }).waitFor();
  await select.selectOption('A');
  await page.getByRole('button', { name: '只看不改 · 当前', exact: false }).waitFor();
  await page.getByText('界面/API 记录', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const shots = new URL('../../tmp/maintenance-ui/', import.meta.url); fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(fileURLToPath(shots), `maintenance-${width}.png`), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
});
