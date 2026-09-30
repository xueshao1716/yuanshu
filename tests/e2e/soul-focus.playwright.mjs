// Isolated browser fixtures: never call production APIs or write real soul data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { GALLERIES, imageForSkin } from '../../frontend/src/components/xiaoyu/widget-state.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.resolve(root, process.env.YUANSHU_TEST_DIST || 'tmp/verification-dist');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(dist, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const labels = { identity: '身份与表达', genes: '性格基因', history: '审批与回退', team: '天团协作', mother: 'aibody 母体', learning: '学习与技能', voice: '声音与形象' };
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROME_PATH ? { executablePath: process.env.YUANSHU_CHROME_PATH } : {}) });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(), errors = [], counts = new Map(), writes = [];
    let pending = false, finishApply;
    const applyGate = new Promise(resolve => { finishApply = resolve; });
    await page.clock.install();
    await page.routeWebSocket('**/*', ws => ws.close());
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (!p.startsWith('/api/')) return route.continue();
      counts.set(p, (counts.get(p) || 0) + 1);
      if (route.request().method() !== 'GET') {
        writes.push(p);
        if (p === '/api/persona/apply') {
          pending = true; await applyGate;
          return route.fulfill({ json: { ok: false, error: 'fixture_denied' } });
        }
        if (p === '/api/agent/confirm') {
          assert.equal(route.request().postDataJSON().ok, false);
          pending = false; finishApply();
          return route.fulfill({ json: { ok: true, outcome: 'denied' } });
        }
        return route.fulfill({ status: 405, json: { error: 'fixture_readonly' } });
      }
      const json = p === '/api/sessions' ? { sessions: [{ id: 'fixture', name: '测试会话', group: 'workspace' }] }
        : p === '/api/persona' ? { definition: { name: '测试角色', age: 25, values: ['真实'] }, source: 'file', problems: [], revision: 'r1', history: [], rendered: '测试人格' }
        : p === '/api/genome' ? { genes: { gentleness: { baseline: 0.8, expression: 0.82 } }, proposals: [], snapshots: [], reviews: [] }
        : p === '/api/persona/confirmations' ? { items: pending ? [{ id: 'confirm-one', sessionId: 'fixture', toolName: 'persona-governance', reason: '隔离测试确认卡', expiresAt: Date.now() + 60000 }] : [], canApprove: true }
        : p === '/api/refine/status' ? { counts: { pending: 1, applied: 2, rejected: 0 } }
        : p === '/api/skills' ? { skills: [] }
        : p === '/api/aibody' ? { principle: '基于真实记录', theory: [], layers: [{ id: 'host', label: '宿主层', summary: '测试宿主摘要', modules: [] }], observedAt: '2026-09-29T12:00:00Z' }
        : p === '/api/team/run' ? { ok: true, run: null, launch: null, snapshotKind: 'none' }
        : p.endsWith('/messages') ? { messages: [], truncated: false }
        : p === '/api/models' ? { models: [], cwd: 'fixture' }
        : p === '/api/time/tasks' ? { tasks: [] }
        : p === '/api/run/overview' ? { active: [], recent: [], health: { status: 'idle', activeCount: 0, failedCount: 0 } }
        : {};
      return route.fulfill({ json });
    });
    await page.addInitScript(() => {
      localStorage.setItem('yuanshu_access_token', 'isolated-soul-test');
      localStorage.setItem('pi_last_session', 'fixture');
      localStorage.setItem('yuanshu_companion_hidden', 'true');
    });
    await page.goto(origin + '/#/soul');
    await page.getByRole('heading', { name: '灵魂培养中心', exact: true }).waitFor();
    const open = async id => {
      if (width < 640) await page.locator('.soul-mobile-nav select').selectOption(id);
      else await page.getByRole('navigation', { name: '培养分区' }).getByRole('button', { name: new RegExp(labels[id]) }).click();
      await page.locator('.soul-section-heading h2').filter({ hasText: labels[id] }).waitFor();
    };
    const fit = async label => {
      const sizes = await page.locator('.soul-page').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth, doc: document.documentElement.scrollWidth, width: innerWidth }));
      assert.ok(sizes.scroll <= sizes.client + 1 && sizes.doc <= sizes.width + 1, `${width}/${label}: horizontal overflow ${JSON.stringify(sizes)}`);
    };
    await open('identity');
    await page.getByLabel('名字', { exact: true }).fill('保留的人格草稿');
    await page.getByLabel('确认记录归属', { exact: true }).selectOption('fixture');
    await open('genes');
    await page.getByRole('textbox', { name: /^调整理由/ }).fill('保留的基因理由');
    await open('team');
    await page.getByText('暂无启动器记录', { exact: true }).waitFor();
    await page.clock.runFor(12000);
    await page.waitForTimeout(100);
    assert.ok(counts.get('/api/team/run') >= 2, 'visible team summary refreshes');
    await fit('team');
    await open('mother');
    await page.getByText('测试宿主摘要', { exact: true }).waitFor();
    await fit('mother');
    await open('learning');
    await page.getByText('待提炼审批', { exact: true }).waitFor();
    await fit('learning');
    await open('voice');
    await page.getByRole('link', { name: '回到对话设置声音', exact: true }).waitFor();
    const voiceMode = page.getByRole('combobox', { name: '朗读通道', exact: true });
    await voiceMode.selectOption('cloud');
    await page.getByText('与语音通话使用同款音色', { exact: true }).waitFor();
    assert.equal(await page.locator('.soul-gallery').count(), 4);
    for (const gallery of GALLERIES) {
      const card = page.locator('.soul-gallery').filter({ hasText: gallery.label });
      await card.click();
      assert.equal(await card.getAttribute('aria-pressed'), 'true');
      assert.equal(await card.locator('img').getAttribute('src'), imageForSkin(gallery.id));
      assert.equal(await page.evaluate(() => localStorage.getItem('xiaoyu_skin')), gallery.id);
    }
    const showCompanion = page.getByRole('checkbox', { name: '显示桌面公仔', exact: true });
    await showCompanion.check();
    assert.equal(await page.evaluate(() => localStorage.getItem('yuanshu_companion_hidden')), 'false');
    await showCompanion.uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem('yuanshu_companion_hidden')), 'true');
    await open('learning');
    await open('voice');
    assert.equal(await voiceMode.inputValue(), 'cloud', 'shared voice choice survives section unmount');
    assert.equal(await page.locator('.soul-gallery[aria-pressed="true"] strong').textContent(), GALLERIES.at(-1).label);
    const inactive = Object.fromEntries(['/api/team/run', '/api/aibody', '/api/refine/status', '/api/persona/confirmations'].map(p => [p, counts.get(p) || 0]));
    await page.clock.runFor(130000);
    await page.waitForTimeout(100);
    for (const [p, count] of Object.entries(inactive)) assert.equal(counts.get(p) || 0, count, `${p} must stop polling after leaving its section`);
    await fit('voice');
    await page.screenshot({ path: path.join(root, `tmp/soul-focus-${width}.png`), fullPage: true });
    await open('genes');
    assert.equal(await page.getByRole('textbox', { name: /^调整理由/ }).inputValue(), '保留的基因理由');
    await open('identity');
    assert.equal(await page.getByLabel('名字', { exact: true }).inputValue(), '保留的人格草稿');
    await page.getByRole('button', { name: /查看差异/ }).click();
    await page.getByLabel('修改理由', { exact: true }).fill('隔离测试，不写生产');
    await Promise.all([
      page.waitForRequest(req => req.url().endsWith('/api/persona/apply')),
      page.getByRole('button', { name: '提交并请求人工确认', exact: true }).click(),
    ]);
    await open('voice');
    for (let i = 0; i < 3 && !await page.getByText('隔离测试确认卡', { exact: true }).isVisible(); i++) {
      await page.clock.runFor(1100); await page.waitForTimeout(100);
    }
    await page.getByText('隔离测试确认卡', { exact: true }).waitFor({ timeout: 3000 });
    await page.getByRole('link', { name: '回到对话设置声音', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(new URL(page.url()).hash, '#/soul', 'pending approval blocks leaving route');
    await page.getByRole('button', { name: '拒绝本次操作', exact: true }).click();
    await page.getByText('fixture_denied', { exact: true }).waitFor();
    await open('identity');
    await page.getByRole('button', { name: '放弃草稿并载入当前版本', exact: true }).click();
    await open('team');
    await page.getByRole('link', { name: '进入工作台 · 天团协作', exact: true }).click();
    await page.getByRole('heading', { name: '工作台', exact: true }).waitFor();
    assert.equal(await page.getByLabel('选择工作台视图').inputValue(), 'team');
    await page.getByText('还没有视频专用流程记录', { exact: true }).waitFor();
    assert.deepEqual(writes, ['/api/persona/apply', '/api/agent/confirm']);
    assert.deepEqual(errors, []);
    console.log(`${width}px: drafts, unmount polling, busy confirmation, route guard, team deep link and layout passed`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
