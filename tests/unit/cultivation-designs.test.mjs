import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {defaultPolicy} from '../../engine/cultivation/policy.mjs';

const moduleUrl = new URL('../../engine/cultivation/designs.mjs', import.meta.url);
const design = () => ({name: 'Fixture character', rationale: 'Compare two learning methods',
  goals: ['Check a synthetic example'], curriculum: ['Read then test'],
  temporaryExpression: 'Calm or curious as appropriate', observation: 'Record counterexamples',
  recovery: 'Pause on repeated failures', appearance: {description: 'Synthetic portrait', asset: null},
  clothing: {description: 'Synthetic jacket', asset: null}, voice: {description: 'Synthetic voice', asset: null},
  permissions: {model: 'fixture-model', tools: [], dataScopes: [], remote: false, costUpperBoundCents: 0},
  protectedProposalRefs: []});
const policy = () => ({...defaultPolicy(), enabled: true, expiresAt: '2027-01-01T00:00:00.000Z',
  dailyRequests: 1, models: ['fixture-model']});
async function module() {
  assert.ok(fs.existsSync(moduleUrl), 'design validation must be implemented');
  return import(moduleUrl);
}
test('design is a strict detached draft, with required appearance, clothing and voice', async () => {
  const {validateDesign} = await module(), d = design();
  const valid = validateDesign(d); valid.goals[0] = 'changed';
  assert.notEqual(d.goals[0], valid.goals[0]);
  for (const field of ['author', 'approvedBy', 'baseline'])
    assert.throws(() => validateDesign({...d, [field]: 'forged'}), /invalid_design/);
  for (const field of ['rationale', 'observation', 'recovery', 'appearance', 'clothing', 'voice']) {
    const bad = design(); delete bad[field];
    assert.throws(() => validateDesign(bad), /invalid_design/);
  }
  assert.throws(() => validateDesign({...d, goals: []}), /invalid_design/);
  assert.throws(() => validateDesign({...d, permissions: {...d.permissions, arbitraryCode: true}}), /invalid_design/);
});
test('drafts can survive disabled policy; adoption revalidates permissions and protected references', async () => {
  const {validateDesign, assertAdoptable} = await module(), d = design();
  assert.deepEqual(validateDesign(d), d);
  assert.throws(() => assertAdoptable(d, defaultPolicy()), /policy_disabled/);
  assert.equal(assertAdoptable(d, policy(), {now: Date.parse('2026-09-30')}), true);
  assert.throws(() => assertAdoptable(d, policy(), {now: Date.parse('2028-01-01')}), /policy_expired/);
  assert.throws(() => assertAdoptable({...d, permissions: {...d.permissions, tools: ['shell']}}, policy()), /request_denied/);
  assert.throws(() => assertAdoptable({...d, protectedProposalRefs: ['proposal-fixture']}, policy()), /protected_proposal_pending/);
});
test('asset adoption requires trusted validation scoped to agent, kind, ID and version', async () => {
  const {assertAdoptable, validateDesign} = await module(), d = design();
  d.appearance.asset = {id: 'fixture-asset', version: 2};
  assert.deepEqual(validateDesign(d), d);
  assert.throws(() => assertAdoptable(d, policy()), /asset_unverified/);
  const seen = [];
  assert.equal(assertAdoptable(d, policy(), {agentId: 'fixture-agent', verifyAsset: binding => {
    seen.push(binding); return true;
  }}), true);
  assert.deepEqual(seen, [{agentId: 'fixture-agent', kind: 'appearance', id: 'fixture-asset', version: 2}]);
  assert.throws(() => assertAdoptable(d, policy(), {verifyAsset: async () => true}), /asset_unverified/);
  d.appearance.asset.version = 'latest';
  assert.throws(() => validateDesign(d), /invalid_design/);
});

test('revisions cannot expand the adopted permission envelope', async () => {
  const {assertNoExpansion} = await module(), d = design();
  assert.doesNotThrow(() => assertNoExpansion(d, d));
  assert.throws(() => assertNoExpansion({...d, permissions: {...d.permissions, tools: ['shell']}}, d), /permission_expansion/);
});
