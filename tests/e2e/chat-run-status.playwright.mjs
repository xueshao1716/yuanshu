import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMaintenanceFixture } from './fixtures/maintenance-server.mjs';
let fixture, browser;
before(async () => { fixture = await startMaintenanceFixture('chat-run-status-ui.tsx'); browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); await fixture?.server.close(); });

for (const width of [1440, 390]) test(`whole task panel visibility at ${width}px`, { timeout: 90000 }, async t => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  t.after(() => context.close());
  const errors = [], writes = [], unexpected = [];
  let failed = false, offline = false;
  const group = { count: 0, items: [] };
  const run = { id: 'fixture-run', sessionId: 'fixture', status: 'running',
    backgroundRecovery: { enabled: true, used: 0, maxResumes: 3, deadlineAt: '2026-09-27T01:19:00Z', state: 'idle' },
    explanation: { goal: '验证整块任务信息', status: { code: 'running', label: '正在执行', detail: '已保存执行进度' },
      updatedAt: '2026-09-26T23:36:37Z', tools: { count: 52, items: [] }, subagents: group, artifacts: group,
      verification: { ...group, state: 'not_observed' }, executor: { engine: '元枢', model: '测试模型' },
      basis: [], memory: { writes: 0, summary: '' }, notes: [], nextStep: '等待本轮返回', problem: '' } };
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== fixture.origin) { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (req.method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/api/run/overview') {
      if (offline) return route.fulfill({ status: 503, json: { error: 'offline' } });
      const current = failed ? { ...run, status: 'failed', explanation: { ...run.explanation, status: { code: 'failed', label: '执行失败', detail: '测试失败' } } } : run;
      return route.fulfill({ json: { active: failed ? [] : [current], recent: failed ? [current] : [] } });
    }
    if (url.pathname.includes('emotion')) return route.fulfill({ json: { state: { label: '平静' } } });
    unexpected.push(url.pathname); return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(fixture.origin + '/__maintenance');
  const hide = page.getByRole('button', { name: '隐藏任务详情', exact: true });
  const show = page.getByRole('button', { name: '显示任务详情', exact: true });
  await hide.waitFor();
  const panelId = await hide.getAttribute('aria-controls');
  const details = page.locator(`[id="${panelId}"]`);
  assert.equal(await details.isVisible(), true);
  const box = await hide.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
  await hide.click();
  assert.equal(await details.isVisible(), false);
  assert.equal(await show.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.getByRole('button', { name: '停止运行', exact: true }).isVisible(), true);
  assert.deepEqual(writes, []);
  await page.reload(); await show.waitFor();
  assert.equal(await page.getByText('工具记录 52', { exact: true }).isVisible(), false);
  await show.focus(); await page.keyboard.press('Enter'); await hide.waitFor();
  assert.equal(await page.getByText('工具记录 52', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: '关闭自动接续', exact: true }).click();
  await page.getByText('自动接续已关闭。', { exact: false }).waitFor();
  await hide.click(); await show.click();
  assert.equal(await page.getByRole('button', { name: '关闭自动接续', exact: true }).count(), 0);
  assert.equal(writes.length, 1);
  await hide.click(); failed = true; await page.reload(); await show.waitFor();
  assert.equal(await page.getByText('任务详情 · 执行失败', { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '重试运行', exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  offline = true; await page.reload(); await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('alert').isVisible(), true);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
});
