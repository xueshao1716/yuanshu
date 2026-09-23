// Isolated real browser; no production sessions, keys or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright');
import { withoutLegacyReferenceMedia } from '../../engine/legacy-media-events.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'frontend/dist');
const sid = 'isolated-media-provenance', runId = 'media-replay';
const url = p => '/api/ws/file?path=' + encodeURIComponent(p);
const oldImage = url('生成物/其他会话.png'), oldVideo = url('生成物/其他会话.mp4');
const currentImage = url('生成物/本轮.png');
const now = new Date().toISOString();
const reader = { id: 'read-1', name: 'read', args: { path: '工程/经验库/记录.md' },
  output: '参考：生成物/其他会话.png 和 生成物/其他会话.mp4', isError: false, running: false };
const generator = { id: 'image-1', name: 'generate_image', args: { prompt: '本轮隔离测试', aspect_ratio: '2:3' },
  output: `已生成 ${currentImage}`, isError: false, running: false };
const history = [
  { id: 'u1', role: 'user', text: '读取参考文档后，生成一张本轮图片', ts: new Date(Date.parse(now) - 10_000).toISOString() },
  { id: 'a1', role: 'assistant', text: '本轮图片已完成。', images: [currentImage], ts: now },
];
const local = { ...history[1], id: 'cached-a1', sessionId: sid, synced: true, draft: false,
  images: [oldImage, currentImage], videos: [oldVideo], tools: [reader, generator] };
const archived = [
  { type: 'tool', data: reader },
  { type: 'tool_end', data: reader },
  { type: 'media', data: { type: 'image', url: oldImage } },
  { type: 'media', data: { type: 'video', url: oldVideo } },
  { type: 'tool', data: generator },
  { type: 'tool_end', data: generator },
  { type: 'media', data: { type: 'image', url: currentImage, source: 'tool_result', toolCallId: generator.id, toolName: generator.name } },
  { type: 'delta', data: { text: '本轮图片已完成。' } },
  { type: 'completed', data: {} },
].map((e, i) => ({ ...e, runId, sessionId: sid, seq: i + 1 }));
const replay = withoutLegacyReferenceMedia(archived);
assert.equal(replay.filter(e => e.type === 'media').length, 1);

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(dist, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end();
  }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)];
  res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROME_PATH
    ? { executablePath: process.env.YUANSHU_CHROME_PATH } : {}) });
  for (const mode of ['desktop-cache', 'mobile-cache', 'desktop-live', 'mobile-live']) {
    const live = mode.endsWith('live');
    let completed = false;
    const context = await browser.newContext({ viewport: { width: mode.startsWith('mobile') ? 390 : 1440, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.route('**/*', async route => {
      const req = route.request(), parsed = new URL(req.url()), p = parsed.pathname;
      if (req.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body:
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
      if (parsed.origin !== base) return route.abort();
      if (!p.startsWith('/api/')) return route.continue();
      const json = value => route.fulfill({ json: value });
      if (req.method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'fixture is read-only' } });
      if (p === '/api/sessions') return json({ sessions: [{ id: sid, name: '隔离媒体验收', updatedAt: now }] });
      if (p === `/api/sessions/${sid}/messages`) return json({ messages: live && !completed ? history.slice(0, 1) : history, truncated: false });
      if (p === `/api/sessions/${sid}/stream`) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {"lastSeq":0}\n\n' });
      if (p === '/api/run/overview') return json({ active: [], recent: [] });
      if (p === `/api/runs/${runId}`) return json({ id: runId, sessionId: sid, status: completed ? 'completed' : 'running', lastSeq: archived.length });
      if (p === `/api/runs/${runId}/events`) {
        completed = true;
        return route.fulfill({ contentType: 'text/event-stream', body: replay.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') });
      }
      return json({});
    });
    await page.addInitScript(({ sid, runId, local, live }) => {
      localStorage.setItem('yuanshu_access_token', 'isolated-test-token');
      localStorage.setItem('pi_last_session', sid);
      if (localStorage.getItem('media_fixture_seeded')) return;
      localStorage.setItem('media_fixture_seeded', '1');
      if (live) localStorage.setItem(`pi_active_run:${sid}`, JSON.stringify({ runId, sessionId: sid,
        assistantMessageId: local.id, lastSeq: 0, status: 'running', stream: {
          text: '', think: '', thinkDone: false, conclusion: '', tools: [], images: [], files: [], notes: [], audios: [], videos: [],
        } }));
      const request = indexedDB.open('pi_web_messages', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId'); store.createIndex('ts', 'ts');
      };
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('messages', 'readwrite');
        if (!live) tx.objectStore('messages').put(local);
        tx.oncomplete = () => db.close();
      };
    }, { sid, runId, local, live });
    const check = async () => {
      const imgs = page.locator('.chat-turn-list button[aria-label^="查看大图"] img');
      await imgs.first().waitFor({ timeout: 15000 }).catch(async e => {
        console.error(JSON.stringify({ mode, pageErrors: errors, url: page.url(), body: (await page.locator('body').innerText()).slice(0, 3000) }));
        throw e;
      });
      await page.waitForFunction(() => document.querySelector('.chat-turn-list')?.textContent?.includes('本轮图片已完成。'));
      assert.equal(await imgs.count(), 1, `${mode}: only one current image`);
      assert.equal(new URL(await imgs.first().getAttribute('src'), base).searchParams.get('path'), '生成物/本轮.png');
      assert.equal(await page.locator('.chat-turn-list video').count(), 0, `${mode}: no reference video`);
      assert.equal(await page.locator('.chat-turn-list .markdown-body-wrapper').filter({ hasText: '本轮图片已完成。' }).count(), 1);
    };
    await page.goto(base + '/#/chat', { waitUntil: 'networkidle' });
    await check();
    await page.reload({ waitUntil: 'networkidle' });
    await check();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode, currentImages: 1, referenceMedia: 0, afterRefresh: 'pass', pageErrors: 0 }));
    await context.close();
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
