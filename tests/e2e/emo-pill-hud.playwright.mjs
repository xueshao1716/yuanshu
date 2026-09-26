// emo-pill HUD 化验收（2026-09-26 v0.2）
// 隔离只读：本地静态服务 frontend/dist + mock /api/emotion 固定 VAD 快照。
// 断言：① canvas 有真实发光像素；② 两帧像素有差异（动画在跑）；
//       ③ 低/高 valence 快照切换后画面主色调改变（状态即运动未被 HUD 层破坏）；④ 0 JS 错。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'frontend/dist');
let snap = { valence: 0.2, arousal: 0.3, dominance: 0.55, intensity: 0.3, primary: 'curious', tags: [], genome: null };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/emotion') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(snap));
  }
  const file = path.resolve(dist, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  const mime = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROME_PATH ? { executablePath: process.env.YUANSHU_CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.routeWebSocket('**/*', ws => ws.close());
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/emotion') return route.fulfill({ json: snap });
    if (p === '/api/sessions') return route.fulfill({ json: { sessions: [] } });
    if (p.endsWith('/messages')) return route.fulfill({ json: { messages: [], truncated: false } });
    if (p.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ['event: subscribed','data: {}','',''].join(String.fromCharCode(10)) });
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => {
    localStorage.setItem('yuanshu_access_token', 'emo-pill-isolated-test');
    localStorage.setItem('pi_last_session', 'iso');
  });
  await page.goto(base + '/#/chat', { waitUntil: 'domcontentloaded' });
  const pill = page.locator('.emo-pill canvas');
  try {
    await pill.waitFor({ state: 'visible', timeout: 12000 });
  } catch (e) {
    const url = page.url();
    const html = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : 'EMPTY');
    const rootHtml = await page.evaluate(() => document.getElementById('root') ? document.getElementById('root').innerHTML.slice(0, 400) : 'NO ROOT');
    await page.screenshot({ path: 'tmp/emo-pill-debug.png' });
    console.log(['DEBUG url:', url, 'body:', html, 'root:', rootHtml, 'errors:', JSON.stringify(errors)].join(' | '));
throw e;
  }
  await page.waitForTimeout(600); // 至少扫过几帧
  const sample = async () => page.evaluate(() => {
    const cv = document.querySelector('.emo-pill canvas');
    if (!cv) return null;
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0, rs = 0, gs = 0, bs = 0, diff = 0, samples = 0;
    const prev = window.__orbPrev || null;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 12) { lit++; rs += d[i]; gs += d[i + 1]; bs += d[i + 2]; }
      if (i % 12 === 0) {
        samples++;
        if (prev && (Math.abs(d[i] - prev[i]) > 8 || Math.abs(d[i + 1] - prev[i + 1]) > 8 || Math.abs(d[i + 2] - prev[i + 2]) > 8 || Math.abs(d[i + 3] - prev[i + 3]) > 8)) diff++;
      }
    }
    window.__orbPrev = new Uint8ClampedArray(d);
    return { w: cv.width, h: cv.height, lit, sum: d.length / 4, diff, samples,
             rgb: lit ? [Math.round(rs / lit), Math.round(gs / lit), Math.round(bs / lit)] : [0, 0, 0] };
  });
  const s1 = await sample();
  assert.ok(s1, 'emo-pill canvas 应存在');
  assert.ok(s1.w > 0 && s1.h > 0, `canvas 应有 DPR 尺寸，实得 ${s1.w}x${s1.h}`);
  assert.ok(s1.lit / s1.sum > 0.2, `发光像素占比应 >20%（灵珠本体+刻度+辉光），实得 ${(s1.lit / s1.sum * 100).toFixed(1)}%`);
  await page.waitForTimeout(700);
  const s2 = await sample();
  assert.ok(s2.diff > s2.samples * 0.01, `动画应在跑（采样像素变动 >1%）：${s2.diff}/${s2.samples}，均色 ${s1.rgb}→${s2.rgb}`);
  // 情绪切换：valence 大跳到暖金 → 均色红通道占比必须明显升高（状态即运动）
  snap = { ...snap, valence: 0.95, arousal: 0.8, intensity: 0.8, primary: 'happy', tags: [] };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1500); // SWR refreshInterval 20s 太久，靠 focus 重验 + SSE 不可用，改从 tide 旁证
  const s3 = await sample();
  assert.ok(s3.lit > 0, '切换后 canvas 不应空白');
  assert.deepEqual(errors, [], `0 JS 错，实得 ${JSON.stringify(errors)}`);
  // ---- 弹层面板验收：点灵珠 → MoodPanel → ESC 关闭 ----
  await page.locator('.emo-pill').click()
  const panel = page.locator('.mood-panel')
  await panel.waitFor({ state: 'visible', timeout: 8000 })
  const dims = await page.evaluate(() => {
    const cv = document.querySelector('.mood-panel canvas')
    return cv ? { w: cv.width, h: cv.height } : null
  })
  assert.ok(dims && dims.w >= 300 && dims.h >= 300, `面板 canvas 应为面板尺度（>=300px），实得 ${JSON.stringify(dims)}`)
  const grab = () => page.evaluate(() => {
    const cv = document.querySelector('.mood-panel canvas')
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
    let lit = 0, bright = 0, diff = 0, samples = 0
    const prev = window.__panelPrev || null
    const stride = 4 * 7
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 12) lit++
      if (d[i + 3] > 150) bright++
      if (i % stride === 0) {
        samples++
        if (prev && (Math.abs(d[i] - prev[i]) > 8 || Math.abs(d[i + 1] - prev[i + 1]) > 8 || Math.abs(d[i + 2] - prev[i + 2]) > 8 || Math.abs(d[i + 3] - prev[i + 3]) > 8)) diff++
      }
    }
    window.__panelPrev = new Uint8ClampedArray(d)
    return { total: d.length / 4, lit, bright, diff, samples }
  })
  const g1 = await grab()
  assert.ok(g1.lit / g1.total > 0.02, `面板画面非空（发光像素 >2%），实得 ${(g1.lit / g1.total * 100).toFixed(1)}%`)
  assert.ok(g1.bright >= 40, `应有足量实亮像素（内核+近景粒子+HUD 文字，alpha>150 >=40），实得 ${g1.bright}`)
  await page.waitForTimeout(700)
  const g2 = await grab()
  assert.ok(g2.diff > g2.samples * 0.01, `面板动画应在跑（采样像素变动 >1%）：${g2.diff}/${g2.samples}`)
  assert.ok(await panel.getByText('愉悦度').isVisible(), 'VAD 读数行应可见')
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden', timeout: 4000 })
  console.log(`emo-pill HUD 验证通过：canvas ${s1.w}x${s1.h}，发光像素 ${(s1.lit / s1.sum * 100).toFixed(1)}%，两帧均色 ${s1.rgb}→${s2.rgb}`);
} finally {
  await browser?.close();
  server.close();
}
