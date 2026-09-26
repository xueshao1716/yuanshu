// Isolated built frontend: never talks to the production API or user sessions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.resolve(root, process.env.YUANSHU_TEST_DIST || 'tmp/verification-dist');
const output = path.join(root, 'tmp/portrait-browser');
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(dist, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end();
  }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROME_PATH ? { executablePath: process.env.YUANSHU_CHROME_PATH } : {}) });
  const results = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.route('**/api/**', route => {
      const p = new URL(route.request().url()).pathname;
      const json = p === '/api/persona' ? { definition: { name: '小语' } }
        : p === '/api/frontend-version' ? { appVersion: 'isolated-preview' }
        : p === '/api/tasks' ? { tasks: [] }
        : p === '/api/sessions' ? { sessions: [] }
        : p.endsWith('/messages') ? { messages: [], truncated: false } : {};
      return route.fulfill({ json });
    });
    await page.addInitScript(() => {
      localStorage.setItem('yuanshu_access_token', 'isolated-portrait-test');
      localStorage.setItem('pi_last_session', 'isolated');
      localStorage.setItem('xiaoyu_skin', 'portrait');
      localStorage.setItem('xiaoyu_mode', 'roam');
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/#/chat`);
    const widget = page.locator('.xiaoyu-widget');
    await widget.waitFor({ state: 'visible' });
    await page.locator('.xiaoyu-figure img').evaluate(img => img.decode());
    const before = await page.locator('.xiaoyu-companion').boundingBox();
    await page.waitForTimeout(4400);
    assert.deepEqual(await page.locator('.xiaoyu-companion').boundingBox(), before, 'portrait cannot roam with stored roam preference');
    assert.equal(await page.locator('.xiaoyu-facing').evaluate(el => getComputedStyle(el).transform), 'matrix(1, 0, 0, 1, 0, 0)');
    await widget.click();
    const panel = page.locator('#xiaoyu-panel');
    await panel.waitFor({ state: 'visible' });
    await panel.locator('.xiaoyu-portrait-preview img').evaluate(img => img.decode());
    assert.equal(await panel.getByRole('button', { name: '自由活动', exact: true }).isDisabled(), true);
    assert.match(await panel.innerText(), /全覆盖时装预览/);
    const rect = await panel.boundingBox();
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1, 'panel fits viewport');
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'no horizontal overflow');
    await page.screenshot({ path: path.join(output, `portrait-${viewport.width}.png`) });
    const popupPromise = page.waitForEvent('popup');
    await panel.getByRole('link', { name: '打开完整形象' }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.ok(popup.url().endsWith('/portraits/yuanshu-staircase-v1.webp'));
    await popup.close();
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('link', { name: '下载写真人像立绘' }).click();
    const download = await downloadPromise;
    assert.equal(await download.failure(), null);
    await panel.getByRole('button', { name: 'Q版 表情立绘', exact: true }).click();
    assert.equal(await widget.getAttribute('data-skin'), 'chibi');
    assert.equal(await panel.getByRole('button', { name: '自由活动', exact: true }).getAttribute('aria-pressed'), 'true');
    await panel.getByRole('button', { name: '写真人像 冷白 · 长发', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await panel.count(), 0);
    assert.equal(await widget.evaluate(el => el === document.activeElement), true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.xiaoyu-figure').evaluate(el => getComputedStyle(el).animationName), 'none');
    const box = await widget.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x - 60, box.y - 50, { steps: 8 });
    await page.mouse.up();
    assert.equal(await panel.count(), 0, 'drag must not open settings');
    assert.ok(await page.evaluate(() => !!localStorage.getItem('xiaoyu_pos')), 'drag position persists');
    await page.route('**/portraits/**', route => route.abort());
    await page.reload();
    await page.locator('.xiaoyu-image-fallback').waitFor({ state: 'visible' });
    await widget.click();
    await panel.getByRole('status').filter({ hasText: '形象图片暂时无法加载' }).waitFor({ state: 'visible' });
    assert.deepEqual(errors, []);
    results.push({ viewport, status: 'passed', errors });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
