import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';

const cache = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
const executablePath = fs.readdirSync(cache).filter(name => name.startsWith('chromium-')).reverse()
  .flatMap(name => ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'].map(file => path.join(cache, name, file))).find(fs.existsSync);
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-process-visibility-'));
process.chdir(path.resolve('frontend'));
const server = await createServer({ root: process.cwd(), server: { port: 0 }, plugins: [{ name: 'process-fixture', configureServer(s) {
  s.middlewares.use('/__process-test', async (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(await s.transformIndexHtml('/__process-test', '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test/process-visibility-fixture.tsx"></script></body></html>'));
  });
} }] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__process-test`;
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.abort());
    await page.goto(url);
    const hide = page.getByRole('button', { name: '隐藏工具执行', exact: false });
    await hide.first().waitFor();
    assert.equal(await hide.count(), 2);
    const size = await hide.first().boundingBox(); assert.ok(size.height >= 44);
    await page.getByRole('button', { name: 'bash 执行详情' }).first().focus();
    await page.keyboard.press('Enter');
    await page.getByText('检查输出 0', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, `${mobile ? 'mobile' : 'desktop'}-shown.png`), fullPage: true });
    await hide.first().click();
    assert.equal(await page.getByRole('button', { name: '显示工具执行', exact: false }).count(), 2);
    assert.equal(await page.getByRole('button', { name: 'bash 执行详情' }).count(), 0);
    await page.getByText('本轮失败：测试失败仍然可见', { exact: true }).waitFor();
    assert.equal(await page.getByText('工具详情已隐藏 · 1 项运行中 · 1 项失败，展开查看原因', { exact: true }).count(), 2);
    await page.getByRole('button', { name: '模拟下一条执行事件' }).click();
    await page.getByText('交付结果 1 · 已更新 1 次', { exact: true }).waitFor();
    await page.locator('summary').first().focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('details[open]').count(), 2);
    await page.locator('summary').first().click();
    assert.equal(await page.locator('details[open]').count(), 0);
    await page.screenshot({ path: path.join(artifacts, `${mobile ? 'mobile' : 'desktop'}-hidden.png`), fullPage: true });
    await page.reload();
    await page.getByRole('button', { name: '显示工具执行', exact: false }).first().waitFor();
    assert.equal(await page.locator('details[open]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const other = await context.newPage(); await other.goto(url);
    await other.getByRole('button', { name: '显示工具执行', exact: false }).first().click();
    await page.getByRole('button', { name: '隐藏工具执行', exact: false }).first().waitFor();
    await other.locator('summary').first().click();
    await page.locator('details[open]').first().waitFor();
    await page.reload(); await page.locator('details[open]').first().waitFor();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${mobile ? 'mobile' : 'desktop'}: visibility, keyboard, live updates, persistence, cross-tab sync passed`);
  }
  const restricted = await browser.newContext();
  await restricted.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } }); });
  const page = await restricted.newPage(); await page.goto(url);
  await page.getByRole('button', { name: '隐藏工具执行', exact: false }).first().click();
  await page.getByRole('button', { name: '显示工具执行', exact: false }).first().waitFor();
  await restricted.close();
  console.log(`restricted storage: memory fallback passed\nScreenshots: ${artifacts}`);
} finally { await browser?.close(); await server.close(); }
