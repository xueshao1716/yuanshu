import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { json, readBody } from '../../engine/http-utils.mjs';
import { observeHttpRequest, respondHttpError } from '../../engine/http-lifecycle.mjs';
import { createWithCache } from '../../engine/resp-cache.mjs';
import { createHistoryApi } from '../../engine/history-api.mjs';

// Execute the production request callback without booting models, jobs or the real workspace.
const source = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const server = http.createServer(');
const end = source.indexOf('\n});', start);
assert.ok(start >= 0 && end > start, 'production HTTP callback must be found');
const callback = source.slice(start + 'const server = http.createServer('.length, end + 2);
const auth = source.slice(source.indexOf('function checkAuth(req)'), source.indexOf('\n}', source.indexOf('function checkAuth(req)')) + 2);

export async function serveProductionCallback(t, routes, overrides = {}) {
  const context = vm.createContext({
    URL, observeHttpRequest, respondHttpError, console: { log() {} }, CONFIG: { token: 'route-test-token' },
    __applyStaticCache() {}, corsPolicy: { headers: () => ({}) },
    WORKSHOP_PAGES: {}, reactStatic: null, API_ROUTES: routes, json, readBody,
    withCache: createWithCache(), boardApi: { bootstrap: res => json(res, 200, { ok: true }) },
    historyApi: { list: res => json(res, 200, { backups: [] }), rollback() {} },
    handleEmotion: res => json(res, 200, { mood: 'calm' }),
    emotion: { getTide: () => [], getFeelings: () => [] }, ...overrides,
  });
  vm.runInContext(auth, context);
  const server = http.createServer(vm.runInContext(`(${callback})`, context));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('production HTTP requests never grow or replace the registered route table', async t => {
  const routes = [['GET', '/probe', res => json(res, 200, { ok: true })]];
  const original = routes.slice();
  const base = await serveProductionCallback(t, routes);
  for (let i = 0; i < 25; i++) {
    const response = await fetch(`${base}/probe`, { headers: { Authorization: 'Bearer route-test-token' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  assert.equal(routes.length, original.length, 'request handling must not append duplicate routes');
  assert.deepEqual(routes, original);
});

test('central authentication and method matching still guard routes', async t => {
  let calls = 0;
  const routes = [['GET', '/probe', res => { calls++; json(res, 200, { ok: true }); }]];
  const base = await serveProductionCallback(t, routes);
  for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
    const response = await fetch(`${base}/probe`, { headers });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: '未授权，请提供访问令牌' });
  }
  assert.equal(calls, 0);
  const wrongMethod = await fetch(`${base}/probe`, { method: 'POST', headers: { Authorization: 'Bearer route-test-token' } });
  assert.equal(wrongMethod.status, 404);
  await wrongMethod.text();
  assert.equal(calls, 0);
  const legacyToken = await fetch(`${base}/probe?token=route-test-token`);
  assert.equal(legacyToken.status, 200);
  await legacyToken.text();
  assert.equal(calls, 1);
});

test('extracted workbench routes preserve HTTP contracts, cache and rollback safety', async t => {
  const moduleUrl = new URL('../../engine/workbench-routes.mjs', import.meta.url);
  assert.ok(fs.existsSync(moduleUrl), 'workbench route factory must exist');
  const { createWorkbenchRoutes } = await import(moduleUrl.href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-route-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '工程'));
  const target = path.join(root, '工程', 'example.txt');
  fs.writeFileSync(target, 'current');
  fs.writeFileSync(target + '.bak', 'previous');
  const historyApi = createHistoryApi({ wsRoot: root, json, readBody });
  const deps = {
    json, readBody, withCache: createWithCache(), historyApi,
    boardApi: { bootstrap: res => json(res, 200, { sessions: [], note: 'fixture' }) },
    handleEmotion: res => json(res, 200, { mood: 'calm' }),
    emotion: { getTide: n => [n], getFeelings: n => [n] },
  };
  // Evaluate the actual startup registration, not a separately reimplemented router.
  const registrationStart = source.indexOf('API_ROUTES.push(...createWorkbenchRoutes(');
  assert.ok(registrationStart > source.indexOf('const boardApi ='));
  assert.ok(registrationStart < start, 'registration must happen before the server callback');
  const routes = [];
  vm.runInNewContext(source.slice(registrationStart, start), { ...deps, API_ROUTES: routes, createWorkbenchRoutes });
  assert.equal(routes.length, 4);
  assert.ok(Object.isFrozen(routes), 'startup freezes the complete route registry');
  const base = await serveProductionCallback(t, routes);
  const headers = { Authorization: 'Bearer route-test-token', 'Content-Type': 'application/json' };
  for (const route of ['/api/board/bootstrap', '/api/emotion/summary', '/api/history']) {
    const denied = await fetch(base + route);
    assert.equal(denied.status, 401);
    await denied.text();
    const first = await fetch(base + route, { headers });
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type'), /application\/json/);
    const body = await first.json();
    if (route.endsWith('bootstrap')) assert.deepEqual(body, { sessions: [], note: 'fixture' });
    if (route.endsWith('summary')) {
      assert.deepEqual(body.emotion, { mood: 'calm' });
      assert.deepEqual(body.tide, [300]);
      assert.deepEqual(body.feelings, [50]);
      assert.ok(Number.isFinite(Date.parse(body.at)));
    }
    if (route === '/api/history') { assert.equal(body.ok, true); assert.equal(body.backups.length, 1); }
    else {
      assert.equal(first.headers.get('x-cache'), 'MISS');
      const second = await fetch(base + route, { headers });
      assert.equal(second.headers.get('x-cache'), 'HIT');
      assert.deepEqual(await second.json(), body);
    }
  }
  const rollbackUrl = base + '/api/history/rollback';
  const denied = await fetch(rollbackUrl, { method: 'POST', body: JSON.stringify({ backup: '工程/example.txt.bak' }) });
  assert.equal(denied.status, 401);
  await denied.text();
  assert.equal(fs.readFileSync(target, 'utf8'), 'current');
  for (const [body, expected] of [['{', 400], [JSON.stringify({ backup: '../outside.bak' }), 400], [JSON.stringify({ backup: '工程/missing.txt.bak' }), 404], [JSON.stringify({ padding: 'x'.repeat(8 * 1024 * 1024) }), 413]]) {
    const response = await fetch(rollbackUrl, { method: 'POST', headers, body });
    assert.equal(response.status, expected);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  // Keep the original 8 MB allowance (not readBody's 2 MB default).
  const restored = await fetch(rollbackUrl, { method: 'POST', headers, body: JSON.stringify({ backup: '工程/example.txt.bak', padding: 'x'.repeat(2 * 1024 * 1024) }) });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
  assert.ok(fs.readdirSync(path.dirname(target)).some(name => name.startsWith('example.txt.bak-rollback-')));
  assert.equal(routes.length, 4);
});
