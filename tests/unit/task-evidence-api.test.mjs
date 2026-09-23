import test from 'node:test';
import assert from 'node:assert/strict';
const mod = await import('../../engine/task-evidence-api.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
test('a saved review remains explicit when policy re-evaluation fails', async () => {
  assert.equal(typeof mod.createTaskEvidenceApi, 'function');
  let saved = false, output;
  const api = mod.createTaskEvidenceApi({ service: { review: () => { saved = true; return { acceptance: 'revoke' }; } },
    json: (res, code, body) => { output = { code, body }; }, onReview: async () => { throw new Error('cycle offline'); } });
  await api.review({}, 'r1', {});
  assert.equal(saved, true);
  assert.equal(output.code, 200);
  assert.equal(output.body.acceptance, 'revoke');
  assert.ok(output.body.evolutionError);
});
