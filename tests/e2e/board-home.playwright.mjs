// Browser acceptance against isolated, read-only fixtures. No live sessions or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'frontend/dist');
const output = path.join(root, 'tmp/board-home-20260923');
fs.mkdirSync(output, { recursive: true });
const sessions = [
  { id: 'newer', name: '刚创建的会话', createdAt: '2026-09-22', updatedAt: '2026-09-22', preview: '较早的活动', messageCount: 1 },
  { id: 'resumed', name: '城市影像 · 秋日拍摄计划', createdAt: '2026-08-01', updatedAt: '2026-09-23', preview: '整理取景地点与分镜，下一步确认傍晚的拍摄路线。', messageCount: 20 },
];
const overview = { active: [{ id: 'running', sessionId: 'resumed', status: 'running', phase: 'executing', messagePreview: '整理拍摄计划与交付清单', toolCount: 2, memoryCount: 0, error: null }],
  recent: [{ id: 'old', sessionId: 'newer', status: 'completed', phase: 'completed', messagePreview: '历史飞天舞', toolCount: 0, memoryCount: 0, error: null }],
  health: { status: 'busy', activeCount: 1, failedCount: 0 } };
const deliveries = { deliveries: [
  { name: '秋日拍摄计划.md', type: 'file', wsPath: '交付/秋日拍摄计划.md', mtime: '2026-09-23T10:30:00' },
  { name: '分镜参考', type: 'dir', wsPath: '交付/分镜参考', mtime: '2026-09-22T09:00:00' },
] };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(dist, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROME_PATH ? { executablePath: process.env.YUANSHU_CHROME_PATH } : {}) });
  for (const [mode, width] of [['desktop', 1440], ['phone', 390], ['narrow', 320], ['empty', 390], ['error', 390], ['loading', 390], ['cached-error', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(), errors = [], requests = [];
    let failRefresh = false;
    if (mode === 'cached-error') await page.clock.install();
    page.on('pageerror', e => errors.push(e.message));
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      if (url.origin !== base) return route.abort();
      if (!p.startsWith('/api/')) return route.continue();
      requests.push(p);
      if (req.method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'read-only fixture' } });
      const json = data => route.fulfill({ json: data });
      const boardData = p === '/api/board/bootstrap' || p === '/api/run/overview' || p === '/api/ws/deliveries' || p === '/api/time/tasks' || p.includes('subagent');
      if (mode === 'loading' && boardData) return new Promise(resolve => page.once('close', resolve));
      if ((mode === 'error' || failRefresh) && boardData) return route.fulfill({ status: 503, json: { error: 'isolated unavailable' } });
      const empty = mode === 'empty';
      const current = empty ? { active: [], recent: [], health: { status: 'idle', activeCount: 0, failedCount: 0 } } : overview;
      if (p === '/api/sessions') return json({ sessions: empty ? [] : sessions });
      if (p === '/api/board/bootstrap') return json({ sessions: empty ? [] : sessions, overview: current,
        providers: { providers: [] }, deliveries: empty ? { deliveries: [] } : deliveries, daily: { days: [] }, subagent: { runs: [] } });
      if (p === '/api/run/overview') return json(current);
      if (p === '/api/ws/deliveries') return json(empty ? { deliveries: [] } : deliveries);
      if (p === '/api/time/tasks') return json({ tasks: [] });
      if (p.endsWith('/messages')) return json({ messages: [], truncated: false });
      if (p.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {}\n\n' });
      return json({});
    });
    await page.addInitScript(() => {
      localStorage.setItem('yuanshu_access_token', 'board-isolated-test');
      localStorage.setItem('pi_last_session', 'newer');
    });
    await page.goto(base + '/#/board', { waitUntil: 'domcontentloaded' });
    await page.locator('.board-home').waitFor();
    const focus = page.locator('.board-focus-grid');
    if (mode === 'error') {
      await focus.getByText('部分运行状态无法更新', { exact: false }).waitFor();
      assert.ok(!(await focus.innerText()).includes('当前没有正在执行'));
      assert.ok(!(await page.locator('body').innerText()).includes('状态正常'));
    } else if (mode === 'loading') {
      await focus.getByText('正在读取运行状态…').waitFor();
      assert.ok(!(await focus.innerText()).includes('当前没有正在执行'));
    } else if (mode === 'empty') {
      await focus.getByText('当前没有正在执行的任务', { exact: false }).waitFor();
      await focus.getByText('还没有交付作品', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: '继续会话', exact: true }).count(), 0);
    } else {
      await focus.getByText('整理拍摄计划与交付清单', { exact: true }).waitFor();
      assert.ok(!(await focus.innerText()).includes('历史飞天舞'));
      await page.getByRole('heading', { name: '城市影像 · 秋日拍摄计划', exact: true }).waitFor();
      const file = focus.getByRole('link', { name: /秋日拍摄计划.md/ });
      assert.equal(new URL(await file.getAttribute('href'), base).searchParams.get('path'), '交付/秋日拍摄计划.md');
      assert.equal(await focus.getByRole('link', { name: /分镜参考/ }).getAttribute('href'), '#/assets');
    }
    if (mode === 'cached-error') {
      failRefresh = true;
      await page.clock.fastForward(125_000);
      await focus.getByText('部分运行状态无法更新，以下为上次读取的状态。', { exact: true }).waitFor();
      await focus.getByText('整理拍摄计划与交付清单', { exact: true }).waitFor();
      await focus.getByText('交付记录无法更新，以下为上次读取的记录。', { exact: true }).waitFor();
    }
    if (width <= 640) assert.equal(await page.evaluate(() => document.querySelector('.board-shortcuts').getBoundingClientRect().top >= document.querySelector('.board-focus-grid').getBoundingClientRect().bottom), true, `${mode}: primary work before secondary shortcuts`);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.board-home, .board-home *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).length), 0, `${mode}: no horizontal overflow`);
    assert.equal(await page.locator('.board-home button, .board-home a').evaluateAll(els => els.filter(e => e.getBoundingClientRect().height < 44).length), 0, `${mode}: touch targets`);
    await page.screenshot({ path: path.join(output, `${mode}.png`), fullPage: false });
    if (['desktop', 'phone', 'narrow'].includes(mode)) {
      await page.getByRole('button', { name: '继续会话', exact: true }).click();
      await page.waitForURL('**/#/chat');
      await page.waitForFunction(() => localStorage.getItem('pi_last_session') === 'resumed');
      await page.goto(base + '/#/board');
      await page.getByRole('button', { name: '新建对话', exact: true }).click();
      await page.waitForURL('**/#/chat');
      await page.locator('button[title="请先选择会话"]').waitFor();
      assert.equal(await page.locator('button[title="请先选择会话"]').isEnabled(), false, 'new conversation clears current selection');
    }
    assert.deepEqual(errors, [], `${mode}: no runtime exceptions`);
    console.log(JSON.stringify({ mode, width, result: 'passed', pageErrors: errors.length }));
    await context.close();
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
