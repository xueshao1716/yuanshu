// 请求体超限必须**说得清**，不能只在客户端留一句 fetch failed（2026-09-15 真机踩到）
// 这一条走真的 HTTP：起一个小服务器，假装自己是元枢的路由分发层，把 readBody 的
// 超限路径和分发层的 catch 串起来，看客户端到底收到什么。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { readBody, json } from '../../engine/http-utils.mjs';

test('UTF-8 Chinese and emoji survive every byte boundary', async () => {
  const expected = { text: '元枢🙂中文路径/生成物' };
  const bytes = Buffer.from(JSON.stringify(expected));
  for (let split = 1; split < bytes.length; split++) {
    const req = new PassThrough();
    const result = readBody(req);
    req.write(bytes.subarray(0, split));
    req.end(bytes.subarray(split));
    assert.deepEqual(await result, expected, `split at byte ${split}`);
  }
});

test('body limit counts UTF-8 bytes, including exact boundary', async () => {
  const bytes = Buffer.from(JSON.stringify({ text: '中'.repeat(12) }));
  const exact = new PassThrough();
  const accepted = readBody(exact, bytes.length / 1048576);
  exact.end(bytes);
  assert.deepEqual(await accepted, { text: '中'.repeat(12) });
  const over = new PassThrough();
  const rejected = assert.rejects(readBody(over, (bytes.length - 1) / 1048576), { statusCode: 413 });
  over.end(bytes);
  await rejected;
});

function serveOnce(handler) {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      try { await handler(req, res); }
      catch (e) { try { json(res, Number(e?.statusCode) || 500, { error: String(e?.message || e) }); } catch {} }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise(r => server.close(r)) }));
  });
}

test('超过上限的请求体：客户端要拿到 413 和原因，而不是一句 fetch failed', async () => {
  const { port, close } = await serveOnce(async (req, res) => json(res, 200, await readBody(req, 1)));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }),
    });
    assert.equal(r.status, 413, '超限必须是 413：回 500 等于把"你发太大了"说成"服务端炸了"');
    const body = await r.json();
    assert.match(body.error, /超过 1MB 上限/, '原因里要写出上限，否则用户不知道该压到多小');
    assert.match(body.error, /已收到 1\.\dMB/, '收到多少也要写出来');
  } finally { await close(); }
});

test('正常体积与非法 JSON 的行为不变（别为了超限把别的路径弄坏）', async () => {
  const { port, close } = await serveOnce(async (req, res) => json(res, 200, await readBody(req, 2)));
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 1 }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { a: 1 });

    const bad = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
    });
    assert.equal(bad.status, 400, '非法 JSON 是客户端的错，不该报 500');
    assert.match((await bad.json()).error, /invalid JSON/);
  } finally { await close(); }
});

test('空体仍然解析成 {}（调用方普遍依赖这个默认值）', async () => {
  const { port, close } = await serveOnce(async (req, res) => json(res, 200, await readBody(req, 1)));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await r.json(), {});
  } finally { await close(); }
});
