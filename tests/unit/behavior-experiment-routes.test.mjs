import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { json, readBody } from '../../engine/http-utils.mjs';
import { observeHttpRequest, respondHttpError } from '../../engine/http-lifecycle.mjs';
import { createBehaviorExperiments } from '../../engine/behavior-experiments.mjs';
import { createRunStore } from '../../engine/run-store.mjs';
import { initFileLock } from '../../engine/file-lock.mjs';
const routes = await import('../../engine/behavior-experiment-routes.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e;
});
const source = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const server = http.createServer(');
const end = source.indexOf('\n});', start);
const callback = source.slice(start + 'const server = http.createServer('.length, end + 2);
function declaration(name) {
  const from = source.indexOf(`function ${name}(`);
  return source.slice(from, source.indexOf('\n}', from) + 2);
}
async function serve(t) {
  assert.equal(typeof routes.createBehaviorExperimentRoutes, 'function');
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-behavior-http-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const rootDir = path.join(wsRoot, 'ledger');
  initFileLock({ dir: path.join(wsRoot, 'locks') });
  const store = createRunStore({ rootDir });
  const run = store.create({ sessionId: 's1', clientRequestId: 'r1', message: 'fixture only', backgroundRecovery: { scope: wsRoot } });
  store.update(run.id, { status: 'failed', error: 'fixture failure' });
  const service = createBehaviorExperiments({ wsRoot, rootDir });
  const context = vm.createContext({ URL, observeHttpRequest, respondHttpError, reactStatic: null, console: { log() {} },
    CONFIG: { token: 'fixture-token' }, corsPolicy: { headers: () => ({}) }, WORKSHOP_PAGES: {}, json,
    API_ROUTES: routes.createBehaviorExperimentRoutes({ service, json, readBody }) });
  vm.runInContext(declaration('checkAuth') + '\n' + declaration('__applyStaticCache'), context);
  const server = http.createServer(vm.runInContext(`(${callback})`, context));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/behavior-experiments`;
  const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' };
  const input = { experimentId: 'http-fixture', sourceKind: 'real-task', sessionId: 's1',
    hypothesis: 'protocol fixture, not real improvement', baseline: { runId: run.id, version: 'v1' }, variants: [] };
  return { base, headers, input };
}

test('production callback authenticates every experiment route before reading or writing', async t => {
  const { base } = await serve(t);
  for (const [method, suffix] of [['GET', ''], ['POST', ''], ['GET', '/' + 'a'.repeat(64)], ['POST', '/' + 'a'.repeat(64) + '/revoke']]) {
    const r = await fetch(base + suffix, { method });
    assert.equal(r.status, 401); assert.match(r.headers.get('cache-control'), /no-store/); await r.text();
  }
});
test('authenticated HTTP records, reads, lists, revokes and rejects oversized or fabricated fields', async t => {
  const { base, headers, input } = await serve(t);
  const post = (suffix, body) => fetch(base + suffix, { method: 'POST', headers, body: JSON.stringify(body) });
  const response = await post('', input); assert.equal(response.status, 200, await response.clone().text());
  const r = await response.json(); assert.equal(r.state, 'failed'); assert.equal(r.adoptionEligible, false);
  assert.equal((await (await fetch(base + '/' + r.id, { headers })).json()).id, r.id);
  assert.equal((await (await fetch(base, { headers })).json()).items.length, 1);
  const revoked = await post('/' + r.id + '/revoke', { revision: r.revision, reason: 'fixture cleanup' });
  assert.equal((await revoked.json()).state, 'revoked');
  const large = await post('', { ...input, hypothesis: 'x'.repeat(270000) });
  assert.equal(large.status, 413); await large.text();
  for (const body of [{ ...input, sourceKind: 'synthetic-fixture' }, { ...input, adoptionEligible: true },
    { ...input, actualModels: { text: 'fake' } }]) {
    const invalid = await post('', body); assert.equal(invalid.status, 400); await invalid.text();
  }
});
test('production explicitly mounts recorder without completion or timer hooks', () => {
  assert.ok(source.includes('...createBehaviorExperimentRoutes({ service: behaviorExperiments, json, readBody })'));
  assert.ok(!source.includes('behaviorExperiments.record('));
});
