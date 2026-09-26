// Isolated browser fixture: no real scheduled tasks or backend are invoked.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'tmp/client-startup-check');
fs.mkdirSync(output, { recursive: true });
const files = new Map(['startup.html', 'startup.css', 'startup.mjs'].map(name => [`/${name}`, name]));
const server = http.createServer((req, res) => {
  const file = files.get(req.url);
  if (!file) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('html') ? 'text/html; charset=utf-8' : file.endsWith('css') ? 'text/css' : 'text/javascript');
  res.end(fs.readFileSync(path.join(root, 'app/dist', file)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const errors = [];
try {
  browser = await chromium.launch({ headless: true });
  for (const [label, width, height] of [['desktop', 1280, 820], ['small', 420, 360]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript(() => {
      window.calls = [];
      window.__TAURI__ = { core: { invoke: async name => {
        window.calls.push(name);
        if (name === 'ensure_local_service' && window.calls.length === 1) {
          await new Promise(resolve => { window.releaseStartup = resolve; });
          throw 'TASK_UNAVAILABLE';
        }
      } } };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/startup.html`);
    await page.waitForFunction(() => typeof window.releaseStartup === 'function');
    assert.equal(await page.locator('#retry').isDisabled(), true);
    await page.screenshot({ path: path.join(output, `${label}-waiting.png`), fullPage: true });
    await page.evaluate(() => window.releaseStartup());
    await page.getByText('无法读取元枢守护任务。', { exact: false }).waitFor();
    assert.equal(await page.locator('#retry').isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => window.calls), ['ensure_local_service']);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `${label}-error.png`), fullPage: true });
    await page.locator('#retry').focus();
    await page.keyboard.press('Enter');
    await page.getByText('服务已就绪，正在进入工作台。').waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls), ['ensure_local_service', 'ensure_local_service', 'enter_local_workspace']);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, viewports: 2, tested: ['waiting', 'failure', 'retry', 'keyboard', 'no overflow', 'call order'], output }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
