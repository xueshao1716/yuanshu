import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'frontend/dist'), out = path.join(root, 'tmp/xiaoyu-20260923');
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const relative = decodeURIComponent(url.pathname).replace(/^\/static\//, '/');
  const file = path.resolve(dist, relative === '/' ? 'index.html' : relative.slice(1));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROME_PATH ? { executablePath: process.env.YUANSHU_CHROME_PATH } : {}) });
  for (const [name, width, height, reduced] of [['desktop', 1440, 900, false], ['phone', 390, 844, false], ['narrow', 320, 640, false], ['reduced', 390, 844, true], ['short', 390, 320, false]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? 'reduce' : 'no-preference', hasTouch: width < 500 });
    const page = await context.newPage(), errors = [], requests = [];
    let failImages = false, failTasks = false;
    page.on('pageerror', e => errors.push(e.message));
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.route('**/*', route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (url.origin !== base) return route.abort();
      requests.push(p);
      if (failImages && p.startsWith('/static/branding/')) return route.abort();
      if (!p.startsWith('/api/')) return route.continue();
      const json = data => route.fulfill({ json: data });
      if (p === '/api/persona') return json({ definition: { name: '小语' } });
      if (p === '/api/tasks') return failTasks ? route.fulfill({ status: 503, json: {} }) : json({ tasks: [] });
      if (p === '/api/frontend-version') return json({ appVersion: '2.115.12', version: 2115012 });
      if (p === '/api/update/check') return route.fulfill({ status: 503, json: {} });
      if (p === '/api/sessions') return json({ sessions: [] });
      return json({});
    });
    await page.addInitScript(() => {
      localStorage.setItem('yuanshu_access_token', 'isolated-mascot-test');
      localStorage.setItem('xiaoyu_skin', 'doll-puppet');
      localStorage.setItem('xiaoyu_mode', 'corner');
      localStorage.setItem('xiaoyu_pos', JSON.stringify({ x: 9999, y: 9999 }));
    });
    await page.goto(base + '/#/chat');
    const widget = page.locator('.xiaoyu-widget'), panel = page.locator('#xiaoyu-panel');
    await widget.waitFor();
    await page.waitForFunction(() => { const im = document.querySelector('.xiaoyu-widget img'); return im?.complete && im.naturalWidth > 0; });
    assert.ok(await page.locator('.xiaoyu-widget img').evaluate(im => {
      const canvas = document.createElement('canvas'); canvas.width = im.naturalWidth; canvas.height = im.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(im, 0, 0);
      const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return bytes.some((n, i) => i % 4 === 3 && n === 0);
    }), 'transparent illustration, no opaque rectangular backdrop');
    const box = await widget.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= height);
    if (width < 500) await page.touchscreen.tap(box.x + 48, box.y + 55);
    else await widget.click();
    await panel.waitFor();
    const bounded = async () => {
      const b = await panel.boundingBox();
      assert.ok(b.x >= 11 && b.y >= 11 && b.x + b.width <= width - 11 && b.y + b.height <= height - 11, name + ': panel bounds');
      assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    };
    await bounded();
    assert.equal(await page.getByRole('button', { name: '关闭公仔设置' }).evaluate(el => el === document.activeElement), true);
    for (const [scene, label] of [['garden', '花园'], ['studio', '工作室'], ['moon', '月下']]) {
      await panel.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await panel.locator('.xiaoyu-stage').getAttribute('data-scene'), scene);
      assert.equal(await page.evaluate(() => localStorage.getItem('xiaoyu_scene')), scene);
      if (name === 'desktop') await panel.locator('.xiaoyu-stage').screenshot({ path: path.join(out, `stage-${scene}.png`) });
    }
    await panel.getByRole('button', { name: '拆开今日签' }).click();
    const firstIdea = await panel.locator('.xiaoyu-idea strong').textContent();
    await panel.getByRole('button', { name: '换个灵感' }).click();
    assert.notEqual(await panel.locator('.xiaoyu-idea strong').textContent(), firstIdea);
    if (name === 'desktop' || name === 'phone') {
      const downloaded = page.waitForEvent('download');
      await panel.getByRole('button', { name: '留张合影' }).click();
      const photo = await downloaded;
      const file = path.join(out, `${name}-studio-photo.png`);
      await photo.saveAs(file);
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.readUInt32BE(16), 840);
      assert.equal(bytes.readUInt32BE(20), 1000);
      assert.ok(bytes.length > 10000, 'photo contains rendered scene and portrait');
      await panel.getByText('照片已生成，请查看浏览器下载。').waitFor();
    }
    if (reduced) assert.equal(await panel.locator('.xiaoyu-idea-reveal').evaluate(el => getComputedStyle(el).animationName), 'none');
    await bounded();
    for (const [id, label] of [['doll', '盲盒公仔'], ['chibi', 'Q版 表情立绘'], ['puppet', 'Q版 · 轻动'], ['doll-puppet', '公仔 · 轻动']]) {
      await panel.getByRole('button', { name: label, exact: false }).click();
      assert.equal(await widget.getAttribute('data-skin'), id);
      await page.waitForFunction(() => { const im = document.querySelector('.xiaoyu-widget img'); return im?.complete && im.naturalWidth > 0; });
      assert.ok((await panel.getByRole('link').getAttribute('href')).includes(id.startsWith('doll') ? 'doll-01' : 'xiaoyu-open'));
    }
    assert.equal(requests.some(p => p.includes('/puppet')), false, 'no fragmented rig assets');
    await panel.getByRole('button', { name: '自由活动', exact: true }).click();
    const paused = await widget.boundingBox();
    await page.waitForTimeout(250);
    assert.deepEqual(await widget.boundingBox(), paused, 'panel pauses roaming');
    if (reduced) assert.equal(await page.locator('.xiaoyu-figure').evaluate(el => getComputedStyle(el).animationName), 'none');
    await panel.getByRole('button', { name: '检查更新' }).click();
    await panel.getByRole('status').filter({ hasText: '检查失败' }).waitFor();
    await bounded();
    assert.equal(await panel.locator('button, a').evaluateAll(els => els.every(el => el.getBoundingClientRect().height >= 44)), true, 'touch targets');
    for (const theme of ['mist', 'ink']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await panel.evaluate(el => el.scrollTop = 0);
      const contrast = await panel.evaluate(el => {
        const rgb = text => text.match(/[\d.]+/g).slice(0, 3).map(Number);
        const luminance = channels => channels.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        const style = getComputedStyle(el), a = luminance(rgb(style.color)), b = luminance(rgb(style.backgroundColor));
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      });
      assert.ok(contrast >= 4.5, `${theme}: readable panel text (${contrast})`);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`) });
    }
    await page.keyboard.press('Escape');
    assert.equal(await panel.count(), 0);
    assert.equal(await widget.evaluate(el => el === document.activeElement), true);
    if (name === 'phone' || reduced) {
      await page.evaluate(() => { Math.random = () => .25; });
      await page.mouse.move(0, 0);
      const before = await widget.boundingBox();
      await page.waitForTimeout(5000);
      const after = await widget.boundingBox();
      if (reduced) assert.deepEqual(after, before, 'reduced motion suppresses roaming');
      else assert.ok(Math.hypot(after.x - before.x, after.y - before.y) > 4, 'roaming resumes after closing panel');
    }
    if (name === 'desktop') {
      await widget.click();
      await panel.getByRole('button', { name: '原地陪伴' }).click();
      await page.keyboard.press('Escape');
      const b = await widget.boundingBox();
      await page.mouse.move(b.x + 40, b.y + 45); await page.mouse.down();
      await page.mouse.move(60, 70, { steps: 8 }); await page.mouse.up();
      assert.equal(await panel.count(), 0, 'drag never opens panel');
      const p = await page.evaluate(() => JSON.parse(localStorage.getItem('xiaoyu_pos')));
      assert.ok(p.x < 100 && p.y < 100, 'position persisted');
      await widget.click(); await bounded();
      await panel.getByRole('button', { name: '回到角落' }).click();
      assert.equal(await widget.getAttribute('data-mode'), 'corner');
      await page.keyboard.press('Escape');
      failTasks = true; failImages = true;
      await page.reload();
      await page.locator('.xiaoyu-image-fallback').waitFor();
      await widget.click(); await panel.getByText('任务状态暂不可用').waitFor();
      await panel.getByRole('button', { name: '留张合影' }).click();
      await panel.getByText('照片未能保存，请稍后再试。').waitFor();
    }
    assert.deepEqual(errors, [], `${name}: browser errors`);
    console.log(`${name}: skins, assets, bounds, input, themes, update failure passed`);
    await context.close();
  }
} finally { await browser?.close(); await new Promise(r => server.close(r)); }
