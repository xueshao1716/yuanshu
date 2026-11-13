// ===== tests/unit/media-ticket.test.mjs —— AUTH-003 短时票据（2026-11-13）=====
//
// 覆盖三块：
//   1) engine/media-ticket.mjs：签发/校验、过期、篡改签名、scope 前缀、ttl 边界、换令牌失效；
//   2) server.mjs 的结构断言：?ticket= 只在白名单路径上看、?token= 仍保留且打 deprecated warn；
//   3) 生产请求回调的真实 HTTP 矩阵（vm 里跑 server.mjs 的 checkAuth/handleTicketRoute，不启动生产服务）：
//      换票 → 用票取文件/连 SSE → 非白名单路径拒票 → 过期/篡改/跨 scope 拒 → ?token= 兼容但留 warn。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  configureTicketKey, issueTicket, verifyTicket, ticketScopeForPath, isTicketScopeAllowed,
  ALLOWED_TICKET_SCOPE_PREFIXES, DEFAULT_TICKET_TTL_MS, MAX_TICKET_TTL_MS,
} from '../../engine/media-ticket.mjs';
import { json, readBody } from '../../engine/http-utils.mjs';
import { observeHttpRequest, respondHttpError } from '../../engine/http-lifecycle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const TOKEN = 'media-ticket-test-token';
configureTicketKey(TOKEN);

function declaration(name) {
  for (const prefix of [`async function ${name}(`, `function ${name}(`]) {
    const from = SOURCE.indexOf(prefix);
    if (from >= 0) return SOURCE.slice(from, SOURCE.indexOf('\n}', from) + 2);
  }
  return '';
}

const authSource = declaration('checkAuth');
const routeSource = declaration('handleTicketRoute');

// ── 1. 签发 / 校验 ────────────────────────────────────────────────
test('签发的票据是 base64url(payload).hmac，payload 只含 scope/exp/nonce', () => {
  const now = 1_800_000_000_000;
  const { ticket, exp } = issueTicket({ scope: 'file:', now });
  const [body, sig] = ticket.split('.');
  assert.ok(body && sig, '票据必须是两段');
  assert.match(body, /^[A-Za-z0-9_-]+$/, 'payload 必须是 base64url');
  assert.match(sig, /^[A-Za-z0-9_-]+$/, '签名必须是 base64url');
  assert.equal(exp, now + DEFAULT_TICKET_TTL_MS);
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(), ['exp', 'nonce', 'scope']);
  assert.equal(payload.scope, 'file:');
  assert.equal(payload.exp, exp);
  assert.equal(payload.nonce.length > 0, true);
  assert.equal(ticket.includes(TOKEN), false, '票据里不能出现长期令牌明文');
  const again = issueTicket({ scope: 'file:', now });
  assert.notEqual(again.ticket, ticket, '每次签发的 nonce 不同');
});

test('有效票据校验通过，并回显 scope/exp', () => {
  const now = Date.now();
  const { ticket, exp } = issueTicket({ scope: 'file:', now });
  const ok = verifyTicket(ticket, { scope: 'file:', now: now + 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.scope, 'file:');
  assert.equal(ok.exp, exp);
});

test('过期边界：now===exp 已过期，now===exp-1 仍有效', () => {
  const now = 1_700_000_000_000;
  const { ticket, exp } = issueTicket({ scope: 'file:', ttlMs: 5_000, now });
  assert.equal(verifyTicket(ticket, { scope: 'file:', now: exp - 1 }).ok, true);
  assert.deepEqual(verifyTicket(ticket, { scope: 'file:', now: exp }), { ok: false, reason: 'expired' });
  assert.equal(verifyTicket(ticket, { scope: 'file:', now: exp + 60_000 }).reason, 'expired');
});

test('篡改 payload 或签名 → bad_signature', () => {
  const { ticket } = issueTicket({ scope: 'file:' });
  const [body, sig] = ticket.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const forgedBody = Buffer.from(JSON.stringify({ ...payload, scope: 'stream:' }), 'utf8').toString('base64url');
  assert.deepEqual(verifyTicket(`${forgedBody}.${sig}`, { scope: 'stream:' }), { ok: false, reason: 'bad_signature' });
  const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(verifyTicket(`${body}.${flipped}`, { scope: 'file:' }).reason, 'bad_signature');
  assert.equal(verifyTicket('not-a-ticket', { scope: 'file:' }).reason, 'malformed');
  assert.equal(verifyTicket(`${body}.`, { scope: 'file:' }).reason, 'malformed');
  assert.equal(verifyTicket(`${Buffer.from('{}').toString('base64url')}.${sig}`, { scope: 'file:' }).reason, 'malformed');
});

test('scope 前缀匹配：file≠stream，stream 可覆盖 stream:music，但不能跨到 notify', () => {
  const broad = issueTicket({ scope: 'stream:' }).ticket;
  assert.equal(verifyTicket(broad, { scope: 'stream:music' }).ok, true);
  assert.equal(verifyTicket(broad, { scope: 'stream:notify' }).ok, true);
  assert.equal(verifyTicket(broad, { scope: 'file:' }).reason, 'scope_mismatch');
  const music = issueTicket({ scope: 'stream:music' }).ticket;
  assert.equal(verifyTicket(music, { scope: 'stream:music' }).ok, true);
  assert.equal(verifyTicket(music, { scope: 'stream:notify' }).reason, 'scope_mismatch');
  const file = issueTicket({ scope: 'file:' }).ticket;
  assert.equal(verifyTicket(file, { scope: 'stream:music' }).reason, 'scope_mismatch');
  assert.equal(verifyTicket(file, { scope: '' }).reason, 'scope_mismatch');
  assert.equal(verifyTicket(file, {}).reason, 'scope_mismatch');
  assert.equal(verifyTicket(file, { scope: 'file' }).reason, 'scope_mismatch', '前缀必须带冒号');
});

test('ttl 边界：非正数拒绝、1ms 可用、超大夹到上限', () => {
  for (const bad of [0, -1, -60_000, NaN, Infinity, 'abc']) {
    assert.throws(() => issueTicket({ scope: 'file:', ttlMs: bad }), /ttlMs/, `ttlMs=${bad} 必须拒绝`);
  }
  const now = 1_700_000_000_000;
  assert.equal(issueTicket({ scope: 'file:', ttlMs: 1, now }).exp, now + 1);
  assert.equal(issueTicket({ scope: 'file:', ttlMs: MAX_TICKET_TTL_MS * 10, now }).exp, now + MAX_TICKET_TTL_MS);
  const oneMs = issueTicket({ scope: 'file:', ttlMs: 1, now }).ticket;
  assert.equal(verifyTicket(oneMs, { scope: 'file:', now }).ok, true);
  assert.equal(verifyTicket(oneMs, { scope: 'file:', now: now + 1 }).reason, 'expired');
});

test('scope 本身非法时拒绝签发（空/超长/含空白）', () => {
  assert.throws(() => issueTicket({ scope: '' }), /scope/);
  assert.throws(() => issueTicket({}), /scope/);
  assert.throws(() => issueTicket({ scope: 'file: ' + 'x'.repeat(200) }), /scope/);
  assert.throws(() => issueTicket({ scope: 'file: a b' }), /scope/);
  assert.equal(isTicketScopeAllowed('file:'), true);
  assert.equal(isTicketScopeAllowed('media:cover.png'), true);
  assert.equal(isTicketScopeAllowed('stream:music'), true);
  assert.equal(isTicketScopeAllowed(''), false);
  assert.equal(isTicketScopeAllowed('admin:'), false);
  assert.equal(isTicketScopeAllowed('file'), false);
});

test('换令牌后旧票据立即失效（密钥由 .token 派生）', () => {
  const { ticket } = issueTicket({ scope: 'file:' });
  configureTicketKey('rotated-token');
  assert.equal(verifyTicket(ticket, { scope: 'file:' }).reason, 'bad_signature');
  configureTicketKey(TOKEN);
  assert.equal(verifyTicket(ticket, { scope: 'file:' }).ok, true);
  assert.throws(() => configureTicketKey(''), /密钥/);
});

// ── 2. checkAuth 白名单（静态断言）─────────────────────────────────
test('checkAuth：ticket 只在白名单路径上被读取，且必须验签；token 分支保留并打 deprecated warn', () => {
  assert.ok(authSource.includes('ticketScopeForPath(url.pathname)'), '必须按路径算 scope');
  assert.ok(authSource.includes('ticketScope ? url.searchParams.get("ticket") : ""'), '非白名单路径不得读取 ticket');
  assert.ok(authSource.includes('verifyTicket(ticket, { scope: ticketScope }).ok'), '票据必须验签后放行');
  assert.ok(authSource.includes('url.searchParams.get("token")'), '?token= 兼容分支必须还在（本期不删）');
  assert.ok(authSource.includes('console.warn('), '兼容分支必须打 warn');
  assert.ok(authSource.includes('deprecated'), 'warn 文案必须标 deprecated');
  assert.ok(authSource.includes('AUTH-003'), 'warn 文案必须带审计编号，便于日志排查');
  // 无效票据直接拒，不回落 ?token=（否则无效票等于白带）
  assert.ok(authSource.includes('return verifyTicket(ticket, { scope: ticketScope }).ok'), '带票无效时必须直接拒');
});

test('票据白名单路径：ws/file、media/*、*/stream；其余路径一律不认 URL 票据', () => {
  const cases = new Map([
    ['/api/ws/file', 'file:'],
    ['/api/media/cover.png', 'media:'],
    ['/api/media', ''],
    ['/api/music/stream', 'stream:music'],
    ['/api/notify/stream', 'stream:notify'],
    ['/api/chat/stream', 'stream:chat'],
    ['/api/sessions', ''],
    ['/api/sessions/abc/stream', ''],
    ['/api/runs/abc/events', ''],
    ['/api/proxy/image', ''],
    ['/api/ticket', ''],
    ['/api/ws/file/extra', ''],
    ['/api/ws/tree', ''],
    ['/static/app.js', ''],
  ]);
  for (const [pathname, expected] of cases) assert.equal(ticketScopeForPath(pathname), expected, pathname);
});

test('POST /api/ticket 只认 Bearer，且 scope 必须落在允许前缀内', () => {
  assert.match(SOURCE, /\["POST", "\/api\/ticket", \(res, req\) => handleTicketRoute\(res, req\)\]/, '必须注册票据路由');
  assert.ok(routeSource.includes('auth.startsWith("Bearer ")'), '换票必须要求 Authorization: Bearer');
  assert.ok(routeSource.includes('isTicketScopeAllowed(scope)'), 'scope 必须做前缀白名单校验');
  assert.ok(routeSource.includes('{ ticket, exp, scope }'), '响应必须回 {ticket, exp, scope}');
  assert.ok(routeSource.includes('readBody(req, 2)'), 'body 读取必须有上限');
  assert.match(SOURCE, /const hasCredential = !!.{0,220}searchParams\.get\("ticket"\)/, '票据必须算凭据，否则图片会吃预认证限流');
  assert.match(SOURCE, /CONFIG\.token = newToken;[\s\S]{0,240}configureTicketKey\(newToken\)/, '换令牌必须重派生票据密钥');
});

// ── 3. 生产回调的真实 HTTP 矩阵 ────────────────────────────────────
const callback = (() => {
  const start = SOURCE.indexOf('const server = http.createServer(');
  const end = SOURCE.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start, '必须能取到生产请求回调');
  return SOURCE.slice(start + 'const server = http.createServer('.length, end + 2);
})();

async function serve(t, routes) {
  configureTicketKey(TOKEN);
  const warnings = [];
  const context = vm.createContext({
    URL, observeHttpRequest, respondHttpError,
    console: { log() {}, warn: (...args) => warnings.push(args.join(' ')) },
    CONFIG: { token: TOKEN },
    // 真实实现：票据校验、路径白名单、换票逻辑
    verifyTicket, ticketScopeForPath,
    issueTicket, isTicketScopeAllowed, ALLOWED_TICKET_SCOPE_PREFIXES,
    // 测试替身：评审关注的是鉴权矩阵，不是限流器的内部状态
    verifyDeviceTokenCached: () => null,
    rateLimitGate: {
      preAuth: () => ({ ok: true }), authSuccess() {},
      chargeAuthFailure: () => ({ locked: false }), check: () => ({ ok: true }),
    },
    clientIpOf: () => '127.0.0.1',
    sendRateLimited(res) { json(res, 429, { error: 'limited' }); },
    corsPolicy: { headers: () => ({}) },
    WORKSHOP_PAGES: {}, reactStatic: null,
    json, readBody,
  });
  vm.runInContext(declaration('checkAuth') + '\n' + declaration('handleTicketRoute'), context);
  const handleTicketRoute = vm.runInContext('handleTicketRoute', context);
  assert.equal(typeof handleTicketRoute, 'function', '必须能取到生产换票处理函数');
  context.API_ROUTES = [...routes, ['POST', '/api/ticket', (res, req) => handleTicketRoute(res, req)]];
  const server = http.createServer(vm.runInContext(`(${callback})`, context));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, warnings };
}

const ROUTES = [
  ['GET', '/api/ws/file', (res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('PNG-BYTES'); }],
  ['GET', '/api/media/cover.png', (res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('COVER'); }],
  ['GET', '/api/notify/stream', (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.end('event: subscribed\ndata: {"lastSeq":0}\n\n');
  }],
  ['GET', '/api/sessions', (res) => json(res, 200, { sessions: [] })],
];

const bearer = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function mint(base, scope) {
  const response = await fetch(`${base}/api/ticket`, { method: 'POST', headers: bearer, body: JSON.stringify({ scope }) });
  assert.equal(response.status, 200, `换票 ${scope} 失败：${await response.clone().text()}`);
  return response.json();
}

test('HTTP：Bearer 换票 → 票据取文件/连 SSE 都通；非白名单路径拒票', async t => {
  const { base } = await serve(t, ROUTES);
  const fileTicket = await mint(base, 'file:');
  assert.equal(fileTicket.scope, 'file:');
  assert.ok(fileTicket.exp > Date.now());

  const media = await fetch(`${base}/api/ws/file?path=${encodeURIComponent('生成物/a.png')}&ticket=${encodeURIComponent(fileTicket.ticket)}`);
  assert.equal(media.status, 200);
  assert.equal(await media.text(), 'PNG-BYTES');

  const streamTicket = await mint(base, 'stream:notify');
  const sse = await fetch(`${base}/api/notify/stream?ticket=${encodeURIComponent(streamTicket.ticket)}`);
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type') || '', /text\/event-stream/);
  assert.match(await sse.text(), /event: subscribed/);

  // 同一张票放到 API 路径上：不认 URL 票据
  const apiWithTicket = await fetch(`${base}/api/sessions?ticket=${encodeURIComponent(fileTicket.ticket)}`);
  assert.equal(apiWithTicket.status, 401);

  // Bearer 仍然照常
  const withBearer = await fetch(`${base}/api/sessions`, { headers: bearer });
  assert.equal(withBearer.status, 200);
});

test('HTTP：过期/篡改/跨 scope 的票据一律 401', async t => {
  const { base } = await serve(t, ROUTES);
  const expired = issueTicket({ scope: 'file:', ttlMs: 1000, now: Date.now() - 5000 }).ticket;
  assert.equal((await fetch(`${base}/api/ws/file?path=a.png&ticket=${encodeURIComponent(expired)}`)).status, 401);

  const valid = issueTicket({ scope: 'file:' }).ticket;
  const [body, sig] = valid.split('.');
  const flipped = `${body}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
  assert.equal((await fetch(`${base}/api/ws/file?path=a.png&ticket=${encodeURIComponent(flipped)}`)).status, 401);

  const streamOnly = issueTicket({ scope: 'stream:notify' }).ticket;
  assert.equal((await fetch(`${base}/api/ws/file?path=a.png&ticket=${encodeURIComponent(streamOnly)}`)).status, 401);

  // 无效票据不走 ?token= 回落：两个参数都给也不放行
  const both = await fetch(`${base}/api/ws/file?path=a.png&ticket=${encodeURIComponent(flipped)}&token=${encodeURIComponent(TOKEN)}`);
  assert.equal(both.status, 401);
});

test('HTTP：?token= 仍可用（老客户端不挂），但每次命中留一行 deprecated warn（60 秒一行）', async t => {
  const { base, warnings } = await serve(t, ROUTES);
  const legacyFile = await fetch(`${base}/api/ws/file?path=a.png&token=${encodeURIComponent(TOKEN)}`);
  assert.equal(legacyFile.status, 200);
  const legacyApi = await fetch(`${base}/api/sessions?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(legacyApi.status, 200, '兼容期不收缩 ?token= 的使用面');
  assert.ok(warnings.length >= 1, '必须打 warn');
  assert.match(warnings[0], /AUTH-003/);
  assert.match(warnings[0], /deprecated/);
  assert.equal(warnings.length, 1, '同一个进程内 60 秒只留一行，避免图片刷日志');
});

test('HTTP：换票必须 Bearer；scope 不受支持/非 JSON 请求体给 400', async t => {
  const { base } = await serve(t, ROUTES);
  const viaQueryToken = await fetch(`${base}/api/ticket?token=${encodeURIComponent(TOKEN)}`, {
    method: 'POST', body: JSON.stringify({ scope: 'file:' }),
  });
  assert.equal(viaQueryToken.status, 401);
  assert.equal((await viaQueryToken.json()).code, 'TICKET_NEEDS_BEARER');

  const unsupported = await fetch(`${base}/api/ticket`, { method: 'POST', headers: bearer, body: JSON.stringify({ scope: 'admin:' }) });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).code, 'TICKET_SCOPE_UNSUPPORTED');

  const emptyScope = await fetch(`${base}/api/ticket`, { method: 'POST', headers: bearer, body: JSON.stringify({}) });
  assert.equal(emptyScope.status, 400);

  const badJson = await fetch(`${base}/api/ticket`, { method: 'POST', headers: bearer, body: '{' });
  assert.equal(badJson.status, 400);
});

test('HTTP：票据 60 秒过期后同一条 URL 立刻失效（无需重启）', async t => {
  const { base } = await serve(t, ROUTES);
  const short = issueTicket({ scope: 'file:', ttlMs: 1500 });
  assert.equal((await fetch(`${base}/api/ws/file?path=a.png&ticket=${encodeURIComponent(short.ticket)}`)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal((await fetch(`${base}/api/ws/file?path=a.png&ticket=${encodeURIComponent(short.ticket)}`)).status, 401);
});
