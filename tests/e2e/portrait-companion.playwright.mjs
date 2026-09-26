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
    const decisions = [];
    let dnd = true;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === `http://127.0.0.1:${server.address().port}` ? route.continue() : route.abort());
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.route('**/api/**', route => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {"key":"isolated","lastSeq":0}\n\n' });
      if (p === '/api/companion/preferences') {
        if (route.request().method() === 'POST') dnd = route.request().postDataJSON().dnd;
        return route.fulfill({ json: { dnd } });
      }
      if (p === '/api/companion/decision') {
        const input = route.request().postDataJSON(); decisions.push(input);
        return route.fulfill({ json: { status: 'ok', decision: { action: 'resting', expression: 'calm', utterance: '当前没有运行任务，可以安静休息。',
          reason: '隔离验收中的空闲状态', evidenceIds: [], durationMs: 10000, shouldInterrupt: false,
          sessionId: input.sessionId, contextEpoch: input.contextEpoch, basisRevision: 'r1', serverEpoch: 'browser-test',
          expiresAt: Date.now() + 10000, actualModel: { provider: 'fixture', id: 'browser-test' }, decisionSource: 'model' } } });
      }
      const json = p === '/api/persona' ? { definition: { name: '小语' } }
        : p === '/api/frontend-version' ? { appVersion: 'isolated-preview' }
        : p === '/api/companion/facts' ? { sessionId: 'isolated', serverEpoch: 'browser-test', revision: 'r1', known: true, currentBusy: false, otherBusy: 0, reading: false, evidenceIds: [] }
        : p === '/api/companion/emotion' ? { state: { valence: .6, arousal: .3, dominance: .5, intensity: .4, primary: 'happy', tags: [] }, scope: 'global-latest', status: 'observed', sourceKind: 'dialogue', observedAt: Date.now(), servedAt: Date.now(), revision: 1, serverEpoch: 'browser-test' }
        : p === '/api/tasks' ? { tasks: [] }
        : p === '/api/sessions' ? { sessions: [{ id: 'isolated', name: '隔离验收', title: '隔离验收', model: 'fixture/test', updatedAt: Date.now() }] }
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
    await widget.locator('.companion-portrait img').evaluate(img => img.decode());
    const before = await page.locator('.xiaoyu-companion').boundingBox();
    await page.waitForTimeout(800);
    assert.deepEqual(await page.locator('.xiaoyu-companion').boundingBox(), before, 'portrait cannot roam with stored roam preference');
    assert.equal(decisions.length, 0, 'DND suppresses automatic model calls');
    await widget.click();
    const panel = page.locator('#xiaoyu-panel');
    await panel.waitFor({ state: 'visible' });
    await panel.locator('.companion-portrait img').evaluate(img => img.decode());
    assert.equal(await panel.getByRole('button', { name: /Q版|自由活动/ }).count(), 0);
    assert.match(await panel.innerText(), /情绪潮汐/);
    await panel.getByRole('button', { name: '休息一下', exact: true }).click();
    await panel.getByText('当前没有运行任务，可以安静休息。', { exact: true }).waitFor();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].sessionId, 'isolated');
    assert.match(await panel.innerText(), /该姿态素材待补/);
    const rect = await panel.boundingBox();
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1, 'panel fits viewport');
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'no horizontal overflow');
    await page.screenshot({ path: path.join(output, `portrait-${viewport.width}.png`) });
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('link', { name: '下载当前立绘' }).click();
    const download = await downloadPromise;
    assert.equal(await download.failure(), null);
    assert.equal(await widget.getAttribute('data-skin'), 'portrait');
    await panel.getByLabel('说句话', { exact: true }).fill('隔离草稿，不应自动发送');
    await panel.getByRole('button', { name: '带到对话', exact: true }).click();
    await panel.getByText('已带到当前会话草稿，检查后由你发送。', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await panel.count(), 0);
    assert.equal(await widget.evaluate(el => el === document.activeElement), true);
    const tide = page.getByRole('button', { name: '查看情绪潮汐与真人形象', exact: true });
    await tide.click();
    const mood = page.getByRole('dialog', { name: '情绪潮汐与真人形象' });
    await mood.waitFor();
    await mood.locator('img').evaluate(img => img.decode());
    assert.match(await mood.innerText(), /与公仔共用同一份情绪快照/);
    assert.match(await mood.innerText(), /0.60/);
    assert.equal(await mood.locator('.companion-portrait').getAttribute('data-action'), await widget.locator('.companion-portrait').getAttribute('data-action'));
    assert.equal(decisions.length, 1, 'opening tide must not duplicate the behavior model call');
    const moodRect = await mood.boundingBox();
    assert.ok(moodRect.x >= 0 && moodRect.y >= 0 && moodRect.x + moodRect.width <= viewport.width + 1 && moodRect.y + moodRect.height <= viewport.height + 1);
    await page.keyboard.press('Escape');
    assert.equal(await mood.isVisible(), false);
    assert.equal(await tide.evaluate(el => el === document.activeElement), true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await widget.locator('.companion-portrait img').evaluate(el => getComputedStyle(el).animationName), 'none');
    const box = await widget.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x - 60, box.y - 50, { steps: 8 });
    await page.mouse.up();
    assert.equal(await panel.count(), 0, 'drag must not open settings');
    assert.ok(await page.evaluate(() => !!localStorage.getItem('xiaoyu_pos')), 'drag position persists');
    await widget.click();
    await panel.getByRole('button', { name: '隐藏', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '显示真人公仔', exact: true }).click();
    await widget.waitFor({ state: 'visible' });
    await page.route('**/assets/portraits/**', route => route.abort());
    await page.reload();
    await widget.locator('.xiaoyu-image-fallback').waitFor({ state: 'visible' });
    await widget.click();
    await panel.locator('.xiaoyu-image-fallback').waitFor({ state: 'visible' });
    assert.deepEqual(errors, []);
    results.push({ viewport, status: 'passed', errors });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
