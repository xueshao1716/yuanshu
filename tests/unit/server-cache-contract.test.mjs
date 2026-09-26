import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { createStaticServer } from '../../lib/static.mjs';
import { json } from '../../engine/http-utils.mjs';
import { observeHttpRequest, respondHttpError } from '../../engine/http-lifecycle.mjs';

// Exercise the production callback and its cache hook, not a reimplementation.
const source = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const server = http.createServer(');
const end = source.indexOf('\n});', start);
assert.ok(start >= 0 && end > start);
const callback = source.slice(start + 'const server = http.createServer('.length, end + 2);
function declaration(name) {
  const from = source.indexOf(`function ${name}(`);
  return from < 0 ? '' : source.slice(from, source.indexOf('\n}', from) + 2);
}

async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-cache-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'assets/portraits'));
  fs.mkdirSync(path.join(root, 'icons'));
  for (const file of ['index.html', 'assets/app-Ab12cd34.js', 'assets/portrait.webp', 'assets/portraits/yuanshu-staircase-v1.webp', 'assets/page.html', 'icons/app.png']) {
    fs.writeFileSync(path.join(root, file), 'fixture');
  }
  const context = vm.createContext({
    URL, observeHttpRequest, respondHttpError, console: { log() {} }, CONFIG: { token: 'cache-test-token' },
    corsPolicy: { headers: () => ({}) }, WORKSHOP_PAGES: {},
    reactStatic: createStaticServer({ publicDir: root }), json,
    API_ROUTES: [['GET', '/api/private.png', res => json(res, 200, { private: true })]],
  });
  vm.runInContext(declaration('checkAuth') + '\n' + declaration('__applyStaticCache'), context);
  const server = http.createServer(vm.runInContext(`(${callback})`, context));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('unauthorized media-looking API responses are never public immutable', async t => {
  const response = await fetch(await serve(t) + '/api/private.png');
  assert.equal(response.status, 401);
  assert.match(response.headers.get('cache-control'), /no-store/);
  await response.text();
});

test('authorized API responses remain private regardless of suffix', async t => {
  const response = await fetch(await serve(t) + '/api/private.png', { headers: { Authorization: 'Bearer cache-test-token' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  await response.text();
});

test('missing fingerprint asset is not cached for a year', async t => {
  const response = await fetch(await serve(t) + '/assets/missing-Ab12cd34.js');
  assert.equal(response.status, 404);
  assert.match(response.headers.get('cache-control'), /no-store/);
  await response.text();
});

test('unversioned images and HTML revalidate; successful fingerprint chunks stay immutable', async t => {
  const base = await serve(t);
  for (const url of ['/assets/portrait.webp', '/assets/portraits/yuanshu-staircase-v1.webp', '/icons/app.png', '/assets/page.html?v=2', '/']) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache', url);
    await response.text();
  }
  const chunk = await fetch(base + '/assets/app-Ab12cd34.js');
  assert.equal(chunk.status, 200);
  assert.match(chunk.headers.get('cache-control'), /public.*immutable/);
  const etag = chunk.headers.get('etag');
  await chunk.text();
  const cached = await fetch(base + '/assets/app-Ab12cd34.js', { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304);
  assert.match(cached.headers.get('cache-control'), /immutable/);
});
