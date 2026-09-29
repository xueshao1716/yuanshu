// Real built ChatArea, isolated HTTP/SSE fixtures. Never reads tokens or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.resolve(root, 'tmp/verification-dist');
const sessions = ['A', 'B'].map(id => ({ id, name: `测试会话${id}`, group: 'workspace' }));
const history = id => Array.from({ length: 32 }, (_, i) => ({ id: `${id}-${i}`, role: i % 2 ? 'assistant' : 'user', text: `${id}记录${i}：${'这是用于验证上翻阅读的隔离测试内容。'.repeat(8)}`, ts: new Date(1700000000000 + i * 1000).toISOString() }));
let scenario, events, seq, submitted, releaseCreate, created;
const sse = (res, body = '') => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.write(body || ': connected\n\n'); };
const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'), p = url.pathname;
  if (p.startsWith('/api/')) {
    if (p === '/api/sessions' && req.method === 'POST') { created = true; return json(res, { id: 'NEW' }); }
    if (p === '/api/sessions') return json(res, { sessions: scenario === 'first' ? (created ? [{ id: 'NEW', name: '首次会话', group: 'workspace' }] : []) : sessions });
    if (p.endsWith('/messages')) return json(res, { messages: scenario === 'first' ? [] : history(p.split('/')[3]), truncated: false });
    if (p.endsWith('/stream')) return sse(res, 'event: subscribed\ndata: {"lastSeq":0}\n\n');
    if (p === '/api/run/overview') return json(res, { active: [], recent: [] });
    if (p === '/api/runs' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      submitted.push(JSON.parse(body));
      if (scenario === 'late') await new Promise(resolve => { releaseCreate = resolve; });
      return json(res, { runId: 'fixture-run', sessionId: scenario === 'first' ? 'NEW' : 'A', status: 'running', lastSeq: 0 });
    }
    if (p === '/api/runs/fixture-run/events') { sse(res); events.add(res); req.on('close', () => events.delete(res)); return; }
    if (p === '/api/runs/fixture-run') return json(res, { id: 'fixture-run', sessionId: 'A', status: 'running', lastSeq: seq });
    return json(res, p === '/api/tasks' ? { tasks: [] } : p === '/api/models' ? { models: [], cwd: 'fixture' } : p === '/api/persona' ? { definition: { name: '测试角色' } } : {});
  }
  const file = path.resolve(dist, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const until = async (fn, label) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(`Timed out: ${label}`); };
const emit = text => { const event = `data: ${JSON.stringify({ runId: 'fixture-run', seq: ++seq, type: 'delta', data: { text } })}\n\n`; for (const res of events) res.write(event); };
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const mode of ['desktop-reading', 'mobile-reading', 'late', 'first']) {
    scenario = mode; events = new Set(); seq = 0; submitted = []; releaseCreate = null; created = false;
    const mobile = mode.startsWith('mobile');
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile, isMobile: mobile });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(({ mode }) => {
      localStorage.setItem('yuanshu_access_token', 'isolated-test');
      if (mode !== 'first') localStorage.setItem('pi_last_session', 'A');
      if (mode.endsWith('reading')) localStorage.setItem('pi_active_run:A', JSON.stringify({ runId: 'fixture-run', sessionId: 'A', assistantMessageId: 'fixture-answer', lastSeq: 0, status: 'running', stream: { text: '', think: '', thinkDone: true, conclusion: '', tools: [], notes: [], files: [], images: [], audios: [], videos: [] } }));
    }, { mode });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const input = page.locator('.mobile-composer textarea');
    await input.waitFor({ state: 'visible' });
    if (mode.endsWith('reading')) {
      await until(() => events.size > 0, 'run subscription');
      emit('开始持续输出。\n\n');
      const scroll = page.locator('.chat-scroll-region');
      await page.getByRole('button', { name: '展开全部 16 轮', exact: true }).click();
      // Expanding history is an intentional reading gesture; reset explicitly.
      await page.getByRole('button', { name: '回到底部', exact: true }).click();
      await page.waitForFunction(() => { const e = document.querySelector('.chat-scroll-region'); return e && e.scrollHeight > e.clientHeight + 1000 && e.scrollHeight - e.clientHeight - e.scrollTop < 15; });
      const before = await scroll.evaluate(e => e.scrollTop);
      await scroll.hover();
      if (mobile) {
        const cdp = await context.newCDPSession(page), box = await scroll.boundingBox();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + 100 }] });
        for (let y = 150; y <= 400; y += 50) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width / 2, y: box.y + y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else await page.mouse.wheel(0, -650);
      await until(async () => (await scroll.evaluate(e => e.scrollTop)) < before - 100, 'user scrolls upward');
      await page.waitForTimeout(500); // allow touch inertia to settle before measuring
      const readingTop = await scroll.evaluate(e => e.scrollTop);
      for (let i = 0; i < 8; i++) { emit(`追加${i}：${'持续输出但不抢滚动位置。'.repeat(10)}\n\n`); await page.waitForTimeout(60); }
      await page.waitForTimeout(300);
      assert.ok(Math.abs((await scroll.evaluate(e => e.scrollTop)) - readingTop) < 10, `${mode}: streaming must not steal reading position`);
      await page.getByRole('button', { name: '回到底部', exact: true }).click();
      emit('主动回底后继续跟随。\n\n');
      await page.waitForFunction(() => { const e = document.querySelector('.chat-scroll-region'); return e.scrollHeight - e.clientHeight - e.scrollTop < 15; });
      await page.screenshot({ path: path.join(root, `tmp/chat-${mode}.png`) });
      console.log(`${mode}: reading lock, explicit return, live follow passed`);
    } else {
      await input.fill(mode === 'first' ? '首次发送保留原问题' : '只属于A的延迟问题');
      await input.press('Enter');
      await until(() => submitted.length === 1, 'submitted once');
      if (mode === 'first') {
        assert.equal(submitted[0].sessionId, 'NEW'); assert.equal(submitted[0].message, '首次发送保留原问题');
        await until(() => events.size > 0, 'first run subscription');
        emit('首次回复正常出现'); await page.getByText('首次回复正常出现', { exact: true }).waitFor();
      } else {
        await page.locator('.session-select').filter({ hasText: '测试会话B' }).click();
        await page.waitForFunction(() => localStorage.getItem('pi_last_session') === 'B');
        releaseCreate(); await page.waitForTimeout(300);
        assert.equal(events.size, 0, 'late A run cannot subscribe from B');
        assert.ok(!(await page.locator('.chat-turn-list').innerText()).includes('只属于A的延迟问题'));
        await page.locator('.session-select').filter({ hasText: '测试会话A' }).click();
        await until(() => events.size > 0, 'return to A resumes correct run');
        emit('A恢复后的正确回复'); await page.getByText('A恢复后的正确回复', { exact: true }).waitFor();
      }
      assert.equal(submitted.length, 1, 'no duplicate submission');
      console.log(`${mode}: session ownership and message delivery passed`);
    }
    assert.deepEqual(errors, [], `${mode}: no uncaught page errors`);
    await context.close();
  }
} finally {
  releaseCreate?.();
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
