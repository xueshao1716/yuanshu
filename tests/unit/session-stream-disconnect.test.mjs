import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/src/api.ts', import.meta.url), 'utf8');
const start = source.indexOf('export function streamSession(');
const end = source.indexOf('// ── 语音转文字', start);
const code = stripTypeScriptTypes(source.slice(start, end).replace('export function', 'function'));
for (const mode of ['eof', 'error', 'cancel']) {
  test(`session stream ${mode} invalidates once except intentional cancellation`, async () => {
    let errors = 0, retries = 0, resolveRead;
    const context = vm.createContext({ AbortController, TextDecoder, _token: 'test', apiUrl: p => p,
      setTimeout: () => { retries++; return 1; }, clearTimeout() {},
      fetch: async () => ({ ok: true, body: { getReader: () => ({ read: () => mode === 'cancel'
        ? new Promise(resolve => { resolveRead = resolve; })
        : mode === 'error' ? Promise.reject(new Error('disconnected')) : Promise.resolve({ done: true }) }) } }),
    });
    vm.runInContext(code, context);
    const stop = context.streamSession('isolated', 0, () => {}, () => { errors++; });
    await new Promise(resolve => setImmediate(resolve));
    if (mode === 'cancel') { stop(); resolveRead({ done: true }); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(errors, mode === 'cancel' ? 0 : 1);
    assert.equal(retries, mode === 'cancel' ? 0 : 1);
    stop();
  });
}
