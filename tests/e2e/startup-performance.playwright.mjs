// Built frontend only; all APIs and external resources are isolated fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.resolve(root, process.env.YUANSHU_TEST_DIST || 'tmp/verification-dist');
const baseline = process.argv.includes('--baseline');
const compare = process.argv.includes('--compare');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.loli.net");
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(dist, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
  if (pathname === '/' && new URL(req.url, 'http://localhost').searchParams.has('baseline')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(root, 'tmp/startup-baseline-index.html')));
  }
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROME_PATH ? { executablePath: process.env.YUANSHU_CHROME_PATH } : {}) });
  for (const width of [1440, 390]) {
    for (const delay of [0, 2000]) {
      for (let run = 0; run < 3; run++) {
       for (const variant of compare ? (run % 2 ? ['after', 'before'] : ['before', 'after']) : [baseline ? 'before' : 'after']) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        let sessions = 0;
        let fontsLoaded = false;
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.routeWebSocket('**/*', ws => ws.close());
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.hostname === 'fonts.loli.net') {
            await new Promise(resolve => setTimeout(resolve, delay));
            fontsLoaded = true;
            return route.fulfill({ contentType: 'text/css', body: ':root { --startup-font-fixture: loaded; }' });
          }
          if (url.origin !== origin) return route.abort();
          if (!url.pathname.startsWith('/api/')) return route.continue();
          if (url.pathname === '/api/sessions') sessions++;
          const json = url.pathname === '/api/sessions' ? { sessions: [{ id: 'fixture-old', name: '性能测试会话', group: 'workspace' }] }
            : url.pathname.endsWith('/messages') ? { messages: [], truncated: false }
            : url.pathname === '/api/tasks' ? { tasks: [] }
            : url.pathname === '/api/models' ? { models: [], cwd: 'fixture' }
            : url.pathname === '/api/persona' ? { definition: { name: '测试角色' } } : {};
          return route.fulfill({ json });
        });
        await page.addInitScript(() => {
          localStorage.setItem('yuanshu_access_token', 'isolated-startup-test');
          localStorage.setItem('pi_last_session', 'fixture-old');
        });
        await page.goto(origin + (compare && variant === 'before' ? '/?baseline=1#/chat' : '/#/chat'), { waitUntil: 'commit' });
        const composer = page.locator('textarea').first();
        await composer.waitFor({ state: 'visible', timeout: 15000 });
        await composer.fill('隔离草稿，不会发送');
        const usableMs = await page.evaluate(() => performance.now());
        if (variant === 'after' && delay) assert.equal(fontsLoaded, false, 'composer works before delayed font stylesheet');
        await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--startup-font-fixture').trim() === 'loaded');
        assert.equal(await composer.inputValue(), '隔离草稿，不会发送', 'font load must preserve draft');
        // Allow startup effects to settle, without triggering focus-based refresh.
        await page.waitForTimeout(250);
        results.push({ variant, width, fontDelayMs: delay, run, usableMs: Math.round(usableMs), sessions });
        assert.deepEqual(errors, []);
        if (variant === 'after') assert.equal(sessions, 1, 'one session-directory request per startup');
        await context.close();
       }
      }
    }
  }
  const output = path.join(root, 'tmp', compare ? 'startup-comparison.json' : baseline ? 'startup-baseline.json' : 'startup-after.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
