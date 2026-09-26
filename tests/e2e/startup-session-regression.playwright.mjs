// API fixtures only: no user data or production writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.resolve(root, process.env.YUANSHU_TEST_DIST || 'tmp/verification-dist');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.loli.net");
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(dist, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROME_PATH ? { executablePath: process.env.YUANSHU_CHROME_PATH } : {}) });
  for (const scenario of ['restore', 'new-wins', 'retry', 'missing', 'logout', 'relogin', 'font-failure']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [], histories = [];
    let lists = 0, release;
    const listGate = new Promise(resolve => { release = resolve; });
    await page.routeWebSocket('**/*', ws => ws.close());
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (url.origin !== origin) return scenario === 'font-failure' ? route.abort() : route.fulfill({ body: '', contentType: 'text/css' });
      if (!p.startsWith('/api/')) return route.continue();
      if (p === '/api/sessions' && route.request().method() === 'POST') return route.fulfill({ json: { id: 'fixture-new' } });
      if (p === '/api/sessions') {
        lists++;
        if (scenario === 'new-wins' || scenario === 'logout' || (scenario === 'relogin' && lists === 1)) await listGate;
        if (scenario === 'retry' && lists === 1) return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
        return route.fulfill({ json: { sessions: scenario === 'missing' ? [] : [{ id: 'fixture-old', name: '旧测试会话', group: 'workspace' }, { id: 'fixture-new', name: '新测试会话', group: 'workspace' }] } });
      }
      if (p.endsWith('/messages')) histories.push(p);
      const json = p.endsWith('/messages') ? { messages: [], truncated: false }
        : p === '/api/tasks' ? { tasks: [] }
        : p === '/api/models' ? { models: [], cwd: 'fixture' }
        : p === '/api/persona' ? { definition: { name: '测试角色' } } : {};
      return route.fulfill({ json });
    });
    await page.addInitScript(() => {
      localStorage.setItem('yuanshu_access_token', 'isolated-session-test');
      localStorage.setItem('pi_last_session', 'fixture-old');
    });
    await page.goto(origin + '/#/chat', { waitUntil: 'domcontentloaded' });
    await page.locator('textarea').first().waitFor({ state: 'visible' });
    if (scenario === 'new-wins') {
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
      await page.waitForFunction(() => localStorage.getItem('pi_last_session') === 'fixture-new');
      release();
      await page.locator('.session-select[aria-current="page"]').filter({ hasText: '新测试会话' }).waitFor();
      assert.equal(histories.some(p => p.includes('/fixture-old/')), false);
    } else if (scenario === 'logout' || scenario === 'relogin') {
      await page.getByRole('button', { name: '退出登录', exact: true }).click();
      release();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('textarea').count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('yuanshu_access_token')), null);
      assert.equal(histories.length, 0, 'late list response cannot reopen a session after logout');
      if (scenario === 'relogin') {
        await page.getByPlaceholder('粘贴服务器 .token 内容').fill('isolated-new-login');
        await page.getByRole('button', { name: '进入元枢', exact: true }).click();
        await page.locator('.session-select[aria-current="page"]').filter({ hasText: '旧测试会话' }).waitFor();
        assert.equal(lists, 2, 'new login fetches a fresh session directory');
        assert.ok(histories.some(p => p.includes('/fixture-old/')));
      }
    } else if (scenario === 'missing') {
      await page.waitForTimeout(300);
      assert.equal(histories.length, 0);
    } else {
      await page.locator('.session-select[aria-current="page"]').filter({ hasText: '旧测试会话' }).waitFor({ timeout: 12000 });
      assert.equal(lists, scenario === 'retry' ? 2 : 1);
      assert.ok(histories.some(p => p.includes('/fixture-old/')));
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
      await page.locator('.session-select[aria-current="page"]').filter({ hasText: '新测试会话' }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log(`${scenario}: passed`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
