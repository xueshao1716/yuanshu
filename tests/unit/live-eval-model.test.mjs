import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const implementation = await import('../../scripts/live-eval-model.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const selected = { provider: 'fixture', id: 'selected' };
function fixture(t, status = 200, data = { current: selected, models: [selected] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-eval-config-'));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'test-only-token#with-hash\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(data), { status });
  };
  return { tokenFile, requests, fetchImpl };
}
test('live evaluation loads the explicitly selected local token through a header', async t => {
  assert.equal(typeof implementation.loadLiveEvalModel, 'function', 'missing authenticated live-eval preflight');
  const f = fixture(t);
  const model = await implementation.loadLiveEvalModel(f);
  assert.deepEqual(model, selected);
  assert.equal(f.requests[0].options.headers.Authorization, 'Bearer test-only-token#with-hash');
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.equal(f.requests[0].url.includes('test-only-token'), false);
});
test('live evaluation reports HTTP auth failure without leaking response contents', async t => {
  assert.equal(typeof implementation.loadLiveEvalModel, 'function');
  await assert.rejects(implementation.loadLiveEvalModel(fixture(t, 401, { error: 'secret response body' })), error => {
    assert.match(error.message, /HTTP 401/);
    assert.ok(error.message.includes('YUANSHU_EVAL_TOKEN_FILE'));
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
});
test('live evaluation rejects malformed models and does not silently pick a different model', async t => {
  assert.equal(typeof implementation.loadLiveEvalModel, 'function');
  await assert.rejects(implementation.loadLiveEvalModel(fixture(t, 200, { ok: true })), /模型列表/);
  await assert.rejects(implementation.loadLiveEvalModel({ ...fixture(t), requestedModel: 'other/model' }), /不可用/);
});
test('live evaluation refuses to send the local token to a remote host', async t => {
  assert.equal(typeof implementation.loadLiveEvalModel, 'function');
  const f = fixture(t);
  await assert.rejects(implementation.loadLiveEvalModel({ ...f, baseUrl: 'https://example.com' }), /本机/);
  assert.equal(f.requests.length, 0);
});
