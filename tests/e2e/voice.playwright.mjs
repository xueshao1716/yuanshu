// Real isolated browser UI with deterministic audio adapters; never opens physical mic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..');
const dist = path.join(root, process.env.YUANSHU_VOICE_DIST || 'tmp/verification-dist');
const sid = 'voice-fixture', now = new Date().toISOString();
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(dist, p === '/' ? 'index.html' : p.slice(1));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Permissions-Policy': 'microphone=(self)', 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== base) return route.abort();
      if (!u.pathname.startsWith('/api/')) return route.continue();
      const json = value => route.fulfill({ json: value });
      if (u.pathname === '/api/sessions') return json({ sessions: [{ id: sid, name: '语音隔离验收', updatedAt: now }] });
      if (u.pathname === `/api/sessions/${sid}/messages`) return json({ messages: [
        { id: 'u1', role: 'user', text: '请介绍语音功能', ts: now },
        { id: 'a1', role: 'assistant', text: '你好，这是朗读正文。\n```js\nsecret()\n```', ts: now },
      ], truncated: false });
      if (u.pathname.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {"lastSeq":0}\n\n' });
      if (u.pathname === '/api/run/overview') return json({ active: [], recent: [] });
      return json({});
    });
    await page.addInitScript(({ sid }) => {
      localStorage.setItem('yuanshu_access_token', 'fixture-only'); localStorage.setItem('pi_last_session', sid);
      window.__audio = { spoken: [], stopped: 0, mode: 'ok' };
      Object.defineProperty(window, 'speechSynthesis', { value: {
        getVoices: () => [{ lang: 'zh-CN' }], cancel() {}, pause() {}, resume() {},
        speak(u) { window.__audio.spoken.push(u.text); setTimeout(() => u.onstart?.(), 0); },
      } });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        if (window.__audio.mode === 'denied') throw new DOMException('denied', 'NotAllowedError');
        return { getTracks: () => [{ stop() { window.__audio.stopped++; } }] };
      } });
      window.MediaRecorder = class {
        static isTypeSupported() { return true; }
        start() {} stop() { setTimeout(() => this.onstop?.(), 0); }
      };
    }, { sid });
    await page.goto(base + '/#/chat', { waitUntil: 'networkidle' });
    const read = page.getByRole('button', { name: '朗读回复', exact: true });
    await read.waitFor({ timeout: 20000 });
    assert.equal(await page.getByRole('switch', { name: '自动朗读新回复' }).getAttribute('aria-checked'), 'false');
    assert.equal(await page.evaluate(() => window.__audio.spoken.length), 0);
    await read.click(); await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
    await page.getByRole('button', { name: '继续朗读', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__audio.spoken), ['你好，这是朗读正文。']);
    await page.getByRole('button', { name: '语音输入', exact: true }).click();
    await page.getByRole('button', { name: '取消录音', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '停止朗读', exact: true }).count(), 0);
    await page.getByRole('button', { name: '取消录音', exact: true }).click();
    await page.waitForFunction(() => window.__audio.stopped === 1);
    await page.evaluate(() => { window.__audio.mode = 'denied'; });
    await page.getByRole('button', { name: '语音输入', exact: true }).click();
    await page.getByText(/麦克风权限被拒绝/).waitFor();
    await page.screenshot({ path: path.join(root, `tmp/voice-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, playback: 'pass', pauseResume: 'pass', recordingStopsSpeech: 'pass', cancelReleasesMic: 'pass', permissionError: 'pass', pageErrors: errors.length }));
    await context.close();
  }
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
