import test from 'node:test';
import assert from 'node:assert/strict';
const { readHashToken, consumeHashToken } = await import(new URL('../../frontend/src/lib/hash-token.mjs', import.meta.url));

const TOKEN = 'a'.repeat(48);

test('hash token: only loopback pages and hex tokens are accepted', () => {
  assert.equal(readHashToken({ hostname: '127.0.0.1', hash: '#t=' + TOKEN }), TOKEN);
  assert.equal(readHashToken({ hostname: 'localhost', hash: '#t=' + TOKEN }), TOKEN);
  assert.equal(readHashToken({ hostname: 'evil.example', hash: '#t=' + TOKEN }), '');
  assert.equal(readHashToken({ hostname: '127.0.0.1', hash: '#t=<script>' }), '');
  assert.equal(readHashToken({ hostname: '127.0.0.1', hash: '#t=abc' }), '');
  assert.equal(readHashToken({ hostname: '127.0.0.1', hash: '' }), '');
  assert.equal(readHashToken(null), '');
});

test('hash token: consume stores token, clears remote base and strips the fragment', () => {
  const store = new Map([['base', 'https://remote']]);
  const storage = { setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let replaced = null;
  const history = { replaceState: (_d, _u, url) => { replaced = url; } };
  const location = { hostname: '127.0.0.1', hash: '#t=' + TOKEN, pathname: '/', search: '?x=1' };
  assert.equal(consumeHashToken({ location, history, storage, tokenKey: 'tk', apiBaseKey: 'base' }), TOKEN);
  assert.equal(store.get('tk'), TOKEN);
  assert.equal(store.has('base'), false);
  assert.equal(replaced, '/?x=1');
  assert.equal(consumeHashToken({ location: { hostname: '127.0.0.1', hash: '' }, history, storage, tokenKey: 'tk', apiBaseKey: 'base' }), '');
});
