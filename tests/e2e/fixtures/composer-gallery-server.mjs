// Static built UI with isolated API data: never reads or writes user sessions.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export async function setup(t, width = 1440) {
  const dist = fileURLToPath(new URL('../../../tmp/verification-dist/', import.meta.url));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(dist, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 900 });
  const page = await context.newPage(), errors = [], requests = [];
  page.setDefaultTimeout(5000);
  page.on('pageerror', e => errors.push(e.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.routeWebSocket('**/*', ws => ws.close());
  await page.route('**/api/**', route => {
    const u = new URL(route.request().url()), p = u.pathname;
    requests.push(p + u.search);
    if (p.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {"lastSeq":0}\n\n' });
    const json = p === '/api/sessions' ? { sessions: [{ id: 'isolated', name: '隔离验收', updatedAt: new Date().toISOString() }] }
      : p.endsWith('/messages') ? { messages: [], truncated: false }
      : p === '/api/companion/preferences' ? { dnd: true }
      : p === '/api/companion/facts' ? { sessionId: 'isolated', serverEpoch: 'test', revision: 'r1', known: true, currentBusy: true, reading: true, otherBusy: 0, evidenceIds: [] }
      : p === '/api/companion/emotion' ? { status: 'unavailable' }
      : p === '/api/run/overview' ? { active: [], recent: [] }
      : p === '/api/ws/tree' ? { items: [{ name: 'notes.txt', path: 'notes.txt', type: 'file' }], current: '' }
      : p === '/api/ws/search' ? { results: [{ name: 'notes.txt', path: 'notes.txt' }] }
      : p === '/api/ws/read' ? { path: 'notes.txt', content: 'isolated reference' }
      : {};
    return route.fulfill({ json });
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem('yuanshu_access_token')) {
      localStorage.setItem('yuanshu_access_token', 'isolated-composer-gallery');
      localStorage.setItem('pi_last_session', 'isolated');
      localStorage.setItem('xiaoyu_skin', 'portrait');
    }
  });
  await page.goto(origin + '/#/chat');
  const input = page.locator('.mobile-composer textarea');
  await input.waitFor();
  return { page, context, input, errors, requests };
}

export async function reachable(locator) {
  return locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.y >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
}
