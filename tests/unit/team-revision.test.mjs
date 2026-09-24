import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../engine/team-revision.mjs').catch(() => ({}));
const draft = '买到几份就拍几份；口播：“数量看字幕。”';
const prior = ['预算允许砍单，但台词预设三份买齐'];
const check = { id: 'R1', status: 'resolved', quote: '买到几份就拍几份', reason: '镜头按实际数量呈现，不再预设三份' };
const verdict = checks => JSON.stringify({ pass: true, issues: [], revisionChecks: checks });

test('revision approval requires every previous issue and a quote in the current draft', () => {
  assert.equal(typeof mod.parseTeamReview, 'function');
  const result = mod.parseTeamReview(verdict([check]), draft, prior);
  assert.equal(result.pass, true);
  assert.deepEqual(result.revisionChecks, [{ ...check, issue: prior[0] }]);
  for (const checks of [undefined, [], [check, check], [{ ...check, id: 'R2' }],
    [{ ...check, quote: '三份都买齐了' }], [{ ...check, reason: '' }]]) {
    assert.throws(() => mod.parseTeamReview(verdict(checks), draft, prior), /复核|修订/);
  }
});

test('unresolved closure fails even if the model also sets pass=true and issues=[]', () => {
  assert.equal(typeof mod.parseTeamReview, 'function');
  const result = mod.parseTeamReview(verdict([{ ...check, status: 'unresolved', quote: '', reason: '仍有不一致' }]), draft, prior);
  assert.equal(result.pass, false);
  assert.match(result.issues.join('；'), /R1.*仍有不一致/);
});

test('first review stays compatible but false or malformed verdicts cannot pass', () => {
  assert.equal(typeof mod.parseTeamReview, 'function');
  assert.equal(mod.parseTeamReview('{"pass":true,"issues":[]}', draft).pass, true);
  for (const raw of ['null', '[]', '{"pass":"true","issues":[]}', '{"pass":true,"issues":[""]}'])
    assert.throws(() => mod.parseTeamReview(raw, draft), /复核/);
  assert.equal(mod.parseTeamReview('{"pass":true,"issues":["仍有问题"]}', draft).pass, false);
});
