import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');

test('brand fonts load without a render-blocking head stylesheet', () => {
  const html = read('frontend/index.html');
  const font = html.split('\n').find(line => line.includes('fonts.loli.net/css2'));
  assert.ok(font.includes('media="print"'), 'font CSS must not block screen rendering');
  assert.equal(font.includes('onload='), false, 'production CSP blocks inline event handlers');
  assert.ok(font.includes('data-deferred-fonts'), 'external bootstrap identifies deferred font CSS');
  const main = read('frontend/src/main.tsx');
  assert.ok(main.includes("addEventListener('load'"));
  assert.ok(main.includes('fonts.sheet'), 'cached stylesheet also activates');
});

test('startup session restoration reuses SWR data and respects explicit selection', () => {
  const store = read('frontend/src/store.tsx');
  assert.equal(store.includes('await fetchers.sessions()'), false, 'no second startup list request');
  assert.ok(store.includes('sessionRestorePending.current = false'));
  const select = store.split('\n').find(line => line.includes('selectSession: (sid) =>'));
  assert.ok(select.includes('sessionRestorePending.current = false'), 'new chat/selection cancels restoration');
  assert.ok(store.includes('[authed, sessionsData]'), 'failed request can restore when retry succeeds');
});

test('SWR retries invoke the revalidator argument, never the error object', () => {
  const store = read('frontend/src/store.tsx');
  assert.equal(store.includes('setTimeout(retry, 8000)'), false);
  assert.ok(store.includes('onErrorRetry: (_error, _key, _config, revalidate, options)'));
});

test('logout clears in-memory credentials so pending retries cannot use them', () => {
  const store = read('frontend/src/store.tsx');
  const logout = store.slice(store.indexOf('const logout ='), store.indexOf('// 全局 401'));
  assert.ok(logout.includes("setToken(''); setApiBase('')"));
});
