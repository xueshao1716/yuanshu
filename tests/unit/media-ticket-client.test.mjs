// ===== tests/unit/media-ticket-client.test.mjs —— 前端票据逻辑（AUTH-003，2026-11-13）=====
//
// 前端不能整包 import（api.ts 有 Vite 风格的无扩展名 import），所以拆成两层测：
//   1) frontend/src/lib/media-ticket.ts：scope 推导、URL 拼装、45 秒缓存/续期/失败冷却——纯逻辑，直接跑；
//   2) frontend/src/api.ts 的结构断言：确实走票据、确实只 warn 一次、确实保留一次性降级。
// 另外把前后端的 scope 表做逐项对拍：两张表漂了就是"发出去的票永远验不过"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ticketScopeForUrl, withTicketParam, createTicketStore,
  TICKET_CACHE_MS, TICKET_MIN_REMAIN_MS, TICKET_RETRY_MS,
} from '../../frontend/src/lib/media-ticket.ts';
import { ticketScopeForPath } from '../../engine/media-ticket.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API_SRC = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'api.ts'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('缓存窗口就是 45 秒，票剩余寿命低于 5 秒视为该换票，失败冷却 30 秒', () => {
  assert.equal(TICKET_CACHE_MS, 45_000);
  assert.equal(TICKET_MIN_REMAIN_MS, 5_000);
  assert.equal(TICKET_RETRY_MS, 30_000);
});

test('scope 推导与后端 ticketScopeForPath 逐项一致', () => {
  const paths = [
    '/api/ws/file', '/api/ws/file?path=a.png', '/api/media/cover.png', '/api/media',
    '/api/music/stream?u=abc', '/api/notify/stream', '/api/chat/stream',
    '/api/sessions', '/api/sessions/abc/stream', '/api/runs/abc/events',
    '/api/proxy/image?url=x', '/api/ticket', '/api/ws/file/extra', '/api/ws/tree', '/',
  ];
  for (const pathname of paths) {
    assert.equal(ticketScopeForUrl(pathname), ticketScopeForPath(pathname.split('?')[0]), pathname);
  }
  assert.equal(ticketScopeForUrl(''), '');
  assert.equal(ticketScopeForUrl('https://cdn.example.com/a.png'), '');
  assert.equal(ticketScopeForUrl('data:image/png;base64,AAA'), '');
});

test('URL 拼装：清掉历史 token/sig/ticket，保留业务参数，补上 api base', () => {
  const url = withTicketParam('/api/ws/file?path=生成物%2Fa.png&token=old&sig=stale&ticket=stale2&download=1', 'http://127.0.0.1:8787', 'T1');
  assert.equal(url, 'http://127.0.0.1:8787/api/ws/file?path=%E7%94%9F%E6%88%90%E7%89%A9%2Fa.png&download=1&ticket=T1');
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.has('token'), false, '票据 URL 里不能残留长期令牌');
  assert.equal(parsed.searchParams.has('sig'), false);
  assert.equal(parsed.searchParams.get('ticket'), 'T1');
  assert.equal(withTicketParam('/api/music/stream?u=abc', '', 'T2'), '/api/music/stream?u=abc&ticket=T2');
});

function clockedTicketStore(tickets) {
  let now = 1_700_000_000_000;
  let calls = 0;
  const store = createTicketStore(async () => {
    calls += 1;
    const spec = tickets[calls - 1] ?? tickets[tickets.length - 1];
    if (spec instanceof Error) throw spec;
    return { ticket: `ticket-${calls}`, exp: now + (spec?.ttlMs ?? 60_000) };
  }, { now: () => now });
  return {
    store,
    calls: () => calls,
    advance: ms => { now += ms },
    now: () => now,
  };
}

test('首次同步取票为空但会后台换票；拿到后 45 秒内复用，不再打接口', async () => {
  const c = clockedTicketStore([{}]);
  assert.equal(c.store.sync('file:'), '', '冷启动没有票，调用方降级');
  await tick();
  assert.equal(c.store.peek('file:'), 'ticket-1');
  assert.equal(c.store.sync('file:'), 'ticket-1');
  c.advance(44_000);
  assert.equal(c.store.sync('file:'), 'ticket-1');
  assert.equal(c.calls(), 1, '45 秒窗口内不换票');
  c.advance(1_000); // 距上次签发 45 秒
  assert.equal(c.store.sync('file:'), 'ticket-1', '旧票还没到期，这一帧仍用它，不裂图');
  await tick();
  assert.equal(c.calls(), 2, '超过 45 秒后台续期');
  assert.equal(c.store.peek('file:'), 'ticket-2');
});

test('票快过期（剩余 < 5 秒）时不用它：交给调用方降级，并触发换票', async () => {
  const c = clockedTicketStore([{ ttlMs: 4_000 }, { ttlMs: 60_000 }]);
  assert.equal(await c.store.get('file:'), 'ticket-1');
  assert.equal(c.store.sync('file:'), '', '剩余寿命不足，绝不把快过期的票塞进 URL');
  await tick();
  assert.equal(c.calls(), 2);
  assert.equal(c.store.sync('file:'), 'ticket-2');
});

test('换票失败后冷却 30 秒，不会让每张图都去打接口', async () => {
  const c = clockedTicketStore([new Error('404 未知接口')]);
  assert.equal(c.store.sync('file:'), '');
  await tick();
  assert.equal(c.calls(), 1);
  c.advance(10_000);
  assert.equal(c.store.sync('file:'), '');
  await tick();
  assert.equal(c.calls(), 1, '冷却期内不再重试');
  c.advance(21_000);
  await c.store.get('file:');
  assert.equal(c.calls(), 2, '30 秒后允许重试');
});

test('并发取票只打一次接口；不同 scope 各自分桶', async () => {
  const c = clockedTicketStore([{}, {}, {}]);
  const [a, b] = await Promise.all([c.store.get('file:'), c.store.get('file:')]);
  assert.equal(a, 'ticket-1');
  assert.equal(b, 'ticket-1');
  assert.equal(c.calls(), 1);
  assert.equal(await c.store.get('stream:music'), 'ticket-2');
  assert.equal(c.store.peek('stream:notify'), '', '别的 scope 不共享票据');
});

test('换令牌/登录后 clear：旧票不再复用，重新换票', async () => {
  const c = clockedTicketStore([{}, {}]);
  await c.store.get('file:');
  assert.equal(c.store.peek('file:'), 'ticket-1');
  c.store.clear();
  assert.equal(c.store.peek('file:'), '');
  assert.equal(c.store.sync('file:'), '');
  await tick();
  assert.equal(c.calls(), 2);
  assert.equal(c.store.peek('file:'), 'ticket-2');
});

test('换票响应不完整（缺 ticket/exp）按失败处理，不写入缓存', async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const store = createTicketStore(async () => (++calls === 1 ? { ticket: '' } : { ticket: 'ok', exp: now + 60_000 }), { now: () => now });
  assert.equal(await store.get('file:'), null);
  assert.equal(store.peek('file:'), '');
  now += 31_000;
  assert.equal(await store.get('file:'), 'ok');
});

test('api.ts：withFileToken 走票据、失败降级只 warn 一次、登录后清桶并预取', () => {
  assert.match(API_SRC, /import \{ createTicketStore, ticketScopeForUrl, withTicketParam \} from '\.\/lib\/media-ticket'/);
  assert.match(API_SRC, /export async function getMediaTicket\(scope: string\): Promise<string \| null>/);
  assert.match(API_SRC, /method: 'POST', body: \{ scope \}/, '换票必须 POST /api/ticket 带 scope');
  assert.match(API_SRC, /const ticket = _mediaTickets\.sync\(scope\)/, '渲染期同步取票');
  assert.match(API_SRC, /return withTicketParam\(url, getApiBase\(\), ticket\)/, '有票就拼 ?ticket=');
  assert.match(API_SRC, /function warnTicketFallbackOnce/);
  assert.match(API_SRC, /console\.warn\(/, '降级必须留一次 warn');
  assert.match(API_SRC, /function legacyMediaUrl/, '旧 ?token= 降级路径本期保留');
  assert.match(API_SRC, /token=\$\{encodeURIComponent\(_token\)\}/, '降级时仍按旧规则拼 token');
  assert.match(API_SRC, /_mediaTickets\.clear\(\)/, '换令牌/登录要清票据桶');
  assert.match(API_SRC, /if \(_token\) void resetMediaTickets\(\)/, '首屏预取票据');
  assert.match(API_SRC, /function setToken\([^)]*\) \{[\s\S]{0,260}resetMediaTickets\(\)/, 'setToken 必须重置票据');
});
