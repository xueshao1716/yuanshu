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
  for (const [width, mode] of [[1440, 'device'], [390, 'device'], [1440, 'cloud'], [390, 'cloud']]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== base) return route.abort();
      if (!u.pathname.startsWith('/api/')) return route.continue();
      const json = value => route.fulfill({ json: value });
      if (u.pathname === '/api/tts/capabilities') return json({ available: true, model: 'stepaudio-2.5-tts', provider: 'stepfun-plan', voice: 'elegantgentle-female', voiceLabel: '气质温婉', maxChars: 2000 });
      if (u.pathname === '/api/tts') {
        assert.equal(route.request().headers().authorization, 'Bearer fixture-only');
        assert.equal(route.request().postDataJSON().text, '你好，这是朗读正文。');
        return route.fulfill({ contentType: 'audio/mpeg', body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(120)]) });
      }
      if (u.pathname === '/api/sessions') return json({ sessions: [{ id: sid, name: '语音隔离验收', updatedAt: now }] });
      if (u.pathname === `/api/sessions/${sid}/messages`) return json({ messages: [
        { id: 'u1', role: 'user', text: '请介绍语音功能', ts: now },
        { id: 'a1', role: 'assistant', text: '你好，这是朗读正文。\n```js\nsecret()\n```', ts: now },
      ], truncated: false });
      if (u.pathname.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {"lastSeq":0}\n\n' });
      if (u.pathname === '/api/run/overview') return json({ active: [], recent: [] });
      return json({});
    });
    await page.addInitScript(({ sid, mode }) => {
      localStorage.setItem('yuanshu_access_token', 'fixture-only'); localStorage.setItem('pi_last_session', sid);
      window.__audio = { spoken: [], stopped: 0, mode: 'ok' };
      Object.defineProperty(window, 'speechSynthesis', { value: mode === 'cloud' ? undefined : {
        getVoices: () => [{ lang: 'zh-CN' }], cancel() {}, pause() {}, resume() {},
        speak(u) { window.__audio.spoken.push(u.text); setTimeout(() => u.onstart?.(), 0); },
      } });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      window.Audio = class {
        play() { window.__audio.spoken.push('cloud'); this.onplaying?.(); return Promise.resolve(); }
        pause() {} removeAttribute() {} load() {}
      };
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        if (window.__audio.mode === 'denied') throw new DOMException('denied', 'NotAllowedError');
        return { getTracks: () => [{ stop() { window.__audio.stopped++; } }] };
      } });
      window.MediaRecorder = class {
        static isTypeSupported() { return true; }
        start() {} stop() { setTimeout(() => this.onstop?.(), 0); }
      };
    }, { sid, mode });
    await page.goto(base + '/#/chat', { waitUntil: 'networkidle' });
    const read = page.getByRole('button', { name: '朗读回复', exact: true });
    await read.waitFor({ timeout: 20000 });
    assert.ok(await read.isEnabled(), 'speech capabilities initialize without opening the settings');
    await page.getByRole('button', { name: '查看情绪潮汐与真人形象' }).click();
    await page.getByRole('tab', { name: '声音', exact: true }).click();
    assert.equal(await page.getByRole('switch', { name: '自动朗读新回复' }).getAttribute('aria-checked'), 'false');
    assert.equal(await page.evaluate(() => window.__audio.spoken.length), 0);
    assert.equal(await page.getByRole('combobox', { name: '朗读通道' }).inputValue(), mode);
    if (mode === 'cloud') {
      await page.getByText(/正文发送给阶跃/).waitFor();
      assert.equal(await page.getByRole('switch', { name: '自动朗读新回复' }).isEnabled(), true);
    }
    await page.getByRole('button', { name: '关闭形象面板' }).click();
    await read.click(); await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
    await page.getByRole('button', { name: '继续朗读', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__audio.spoken), mode === 'cloud' ? ['cloud', 'cloud'] : ['你好，这是朗读正文。']);
    await page.getByRole('button', { name: '语音输入', exact: true }).click();
    await page.getByRole('button', { name: '取消录音', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '停止朗读', exact: true }).count(), 0);
    await page.getByRole('button', { name: '取消录音', exact: true }).click();
    await page.waitForFunction(() => window.__audio.stopped === 1);
    await page.evaluate(() => { window.__audio.mode = 'denied'; });
    await page.getByRole('button', { name: '语音输入', exact: true }).click();
    await page.getByText(/麦克风权限被拒绝/).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, `tmp/voice-${mode}-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, mode, playback: 'pass', pauseResume: 'pass', recordingStopsSpeech: 'pass', cancelReleasesMic: 'pass', permissionError: 'pass', pageErrors: errors.length }));
    await context.close();
  }
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
