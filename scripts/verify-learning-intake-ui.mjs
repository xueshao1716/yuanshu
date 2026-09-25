// Browser regression against isolated API fixtures and the verification build.
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { evidenceFixture } from '../tests/helpers/task-evidence-fixture.mjs';
import { json } from '../engine/http-utils.mjs';

const now = '2026-09-25T12:00:00.000Z';
const browser = await chromium.launch({ headless: true,
  ...(process.env.YUANSHU_TEST_CHROME ? { executablePath: process.env.YUANSHU_TEST_CHROME } : {}) });
try {
  for (const width of [1440, 390]) {
    let mode = 'populated', eventError = false;
    const longTitle = '隔离任务' + 'long-title-'.repeat(40);
    const entries = Array.from({ length: 25 }, (_, i) => ({ title: `经验 ${i}`, preview: i === 24 ? '竖图参数实测' : '隔离经验摘要' }));
    const f = await evidenceFixture(path.resolve('tmp/verification-dist'), async (req, res, p) => {
      if (p === '/api/refine/status' || p === '/api/learning-intake/status') {
        if (mode === 'error') { json(res, 503, { error: 'isolated failure' }); return true; }
        if (p === '/api/refine/status') json(res, 200, { experience: { exists: true, source: '工程/经验库/experience.md', updatedAt: now, count: mode === 'empty' ? 0 : 25, entries: mode === 'empty' ? [] : entries } });
        else json(res, 200, { candidates: { ok: true, count: mode === 'empty' ? 0 : 1, backlog: 2, failed: 1, limit: 500, retired: 1, entries: mode === 'empty' ? [] : [{ runId: 'test-run', sessionId: 'test-session', state: 'pending', title: longTitle, at: now }] }, collection: { ok: false, at: now, failed: 1, succeeded: 2, skipped: 3, empty: 1, reason: 'retry_pending' } });
        return true;
      }
      if (p === '/api/agent/events') {
        json(res, eventError ? 503 : 200, eventError ? { error: 'isolated failure' } : { activeCount: 1, events: [
          { id: 'run:test', type: 'completed', ts: now, source: 'run-ledger', data: { text: longTitle, engine: 'yuanshu' } },
          { type: 'task_completed', ts: now, source: 'external', data: { text: '外部测试事件' } },
        ] }); return true;
      }
      return false;
    });
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(15000);
      page.on('pageerror', e => errors.push(e.message));
      await page.routeWebSocket('**/*', ws => ws.close());
      await page.addInitScript(token => localStorage.setItem('yuanshu_access_token', token), f.token);
      await page.goto(`${f.base}/#apps`);
      await page.reload();
      const panel = page.getByRole('region', { name: '日常积累' });
      await panel.getByText('待提炼任务 · 1', { exact: true }).waitFor();
      await panel.getByText('查看最近任务（最多 20 条）', { exact: true }).click();
      await panel.getByText(longTitle, { exact: true }).waitFor();
      await panel.getByRole('alert').filter({ hasText: '采集未全部完成' }).waitFor();
      await panel.getByRole('button', { name: '再显示 20 条' }).click();
      await panel.getByText('经验 24', { exact: true }).waitFor();
      const search = panel.getByRole('searchbox', { name: '搜索经验摘要' });
      await search.fill('竖图');
      await panel.getByText('经验 24', { exact: true }).waitFor();
      assert.equal(await panel.getByText('经验 0', { exact: true }).count(), 0);
      await search.fill('无匹配关键词');
      await panel.getByText('没有匹配的经验摘要，试试其他关键词。', { exact: true }).waitFor();
      await search.fill('');
      let releaseRefresh;
      const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
      await page.route('**/api/learning-intake/status', async route => { await refreshGate; await route.continue(); });
      await panel.getByRole('button', { name: '刷新记录' }).click();
      assert.equal(await panel.getByRole('button', { name: '刷新记录' }).isDisabled(), true);
      releaseRefresh();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '刷新记录' && !b.disabled));
      await page.unroute('**/api/learning-intake/status');
      assert.ok((await panel.getByRole('button', { name: '刷新记录' }).boundingBox()).height >= 44);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await panel.screenshot({ path: `tmp/learning-intake-${width}.png` });
      mode = 'error';
      await panel.getByRole('button', { name: '刷新记录' }).click();
      await panel.getByRole('alert').filter({ hasText: '经验库读取失败' }).waitFor();
      await panel.getByText('经验 0', { exact: true }).waitFor();
      mode = 'empty';
      await panel.getByRole('button', { name: '刷新记录' }).click();
      await panel.getByText('暂无待提炼任务。新的已完成任务会在这里登记。', { exact: true }).waitFor();
      await panel.getByText('暂无经验标题；待提炼任务不会自动写成经验。', { exact: true }).waitFor();
      await page.goto(`${f.base}/#board`);
      await page.getByText('工作记录与用量', { exact: true }).click();
      await page.getByText('1 项任务执行中或排队中', { exact: true }).waitFor();
      await page.getByText(/执行账本 · yuanshu/).waitFor();
      await page.getByText('外部测试事件', { exact: true }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      eventError = true;
      await page.getByText('状态暂不可确认', { exact: true }).waitFor();
      await page.getByText('外部测试事件', { exact: true }).waitFor();
      await page.getByText(/刷新失败，稍后自动重试/).waitFor();
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ width, search: 'passed', pagination: 'passed', retainedOnError: 'passed', empty: 'passed', activitySources: 'passed', status: 'passed', layout: 'passed' }));
    } finally { await context.close(); await f.close(); }
  }
} finally { await browser.close(); }
