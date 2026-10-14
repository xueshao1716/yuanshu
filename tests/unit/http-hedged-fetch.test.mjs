import test from 'node:test';
import assert from 'node:assert/strict';
import { httpHedgedFetch } from '../../engine/http.mjs';

const slowThenFast = (delays) => {
  let n = 0; const aborted = [];
  const impl = (url, { signal }) => {
    const i = n++; const d = delays[i] ?? 0;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ ok: true, who: i }), d);
      signal?.addEventListener('abort', () => { clearTimeout(t); aborted.push(i); reject(new Error('timeout')); });
    });
  };
  return { impl, calls: () => n, aborted };
};

test('首包快：不发第二份', async () => {
  const f = slowThenFast([5]);
  const r = await httpHedgedFetch('u', {}, { hedgeAfterMs: 50, fetchImpl: f.impl });
  assert.equal(r.who, 0); assert.equal(f.calls(), 1);
});
test('首包慢：对冲第二份先到，慢的被取消', async () => {
  const f = slowThenFast([500, 5]);
  const r = await httpHedgedFetch('u', {}, { hedgeAfterMs: 30, fetchImpl: f.impl });
  assert.equal(r.who, 1); assert.equal(f.calls(), 2); assert.deepEqual(f.aborted, [0]);
});
test('hedgeAfterMs=0 不对冲', async () => {
  const f = slowThenFast([40, 1]);
  const r = await httpHedgedFetch('u', {}, { hedgeAfterMs: 0, fetchImpl: f.impl });
  assert.equal(r.who, 0); assert.equal(f.calls(), 1);
});
test('第一份失败时立刻补发第二份，两份都失败才抛错', async () => {
  let n = 0;
  const ok = await httpHedgedFetch('u', {}, { hedgeAfterMs: 1000, fetchImpl: async () => { if (n++ === 0) throw new Error('boom'); return { ok: true, who: 'second' }; } });
  assert.equal(ok.who, 'second');
  await assert.rejects(httpHedgedFetch('u', {}, { hedgeAfterMs: 20, fetchImpl: async () => { throw new Error('down'); } }), /down/);
});
test('外部 signal 取消会传给全部请求', async () => {
  const ctl = new AbortController(); const f = slowThenFast([500, 500]);
  const p = httpHedgedFetch('u', { signal: ctl.signal }, { hedgeAfterMs: 20, fetchImpl: f.impl });
  setTimeout(() => ctl.abort(), 60);
  await assert.rejects(p, /timeout/); assert.deepEqual(f.aborted.sort(), [0, 1]);
});
