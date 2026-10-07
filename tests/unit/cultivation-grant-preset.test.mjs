import test from 'node:test';
import assert from 'node:assert/strict';
const mod = await import(new URL('../../frontend/src/soul/cultivation/grant-preset.mjs', import.meta.url));
const { grantPolicy, classifyBlocked, sharedPatch, supportedDesign, grantSummary } = mod;
const design = { permissions: { model: 'stepfun-plan/step-5-preview', tools: [], dataScopes: ['knowledge:approved-cultivation'], remote: false, costUpperBoundCents: 50 } };
const kp = (over = {}) => ({ revision: 3, currency: 'USD', allowedModels: [], rates: {}, ...over });

test('grant preset matches agreed limits: 7 days, 5 requests/day, $0.50, no tools', () => {
  const now = Date.UTC(2026, 9, 5);
  const p = grantPolicy(design, now);
  assert.equal(p.dailyRequests, 5); assert.equal(p.dailyBudgetCents, 50); assert.equal(p.maxAgents, 1);
  assert.deepEqual(p.tools, []); assert.deepEqual(p.models, [design.permissions.model]);
  assert.deepEqual(p.dataScopes, ['knowledge:approved-cultivation']); assert.equal(p.motherLearning, false);
  assert.equal(Date.parse(p.expiresAt) - now, 7 * 86400000);
  assert.match(grantSummary, /每天 5 次/); assert.match(grantSummary, /0\.50 美元/);
});
test('designs outside the bounded preset are refused', () => {
  assert.equal(supportedDesign(design), true);
  assert.equal(supportedDesign({ permissions: { ...design.permissions, tools: ['bash'] } }), false);
  assert.equal(supportedDesign({ permissions: { ...design.permissions, costUpperBoundCents: 51 } }), false);
  assert.equal(supportedDesign({ permissions: { ...design.permissions, dataScopes: ['memory:private'] } }), false);
});
test('blockers split into grant-fixable, shared-fixable and stubborn', () => {
  const r = classifyBlocked([{ field: 'policy.enabled' }, { field: 'knowledge.rates' }, { field: 'agents.max' }], { includeShared: true });
  assert.deepEqual(r.fixable.map(b => b.field), ['policy.enabled']);
  assert.deepEqual(r.shared.map(b => b.field), ['knowledge.rates']);
  assert.deepEqual(r.stubborn.map(b => b.field), ['agents.max']);
  assert.equal(classifyBlocked([{ field: 'knowledge.rates' }]).stubborn.length, 1, 'shared counts as stubborn unless opted in');
});
test('shared patch whitelists the model and marks free only when the catalog says zero', () => {
  const m = design.permissions.model;
  const free = sharedPatch(kp(), m, { input: 0, output: 0 });
  assert.equal(free.needsManualPrice, false);
  assert.deepEqual(free.patch.allowedModels, [m]);
  assert.deepEqual(free.patch.rates[m], { input: 0, output: 0, currency: 'USD', free: true, tokenBound: 'utf8-bytes' });
  const unknown = sharedPatch(kp(), m, undefined);
  assert.equal(unknown.needsManualPrice, true, 'never guess a price');
  assert.ok(!unknown.patch.rates);
  const paid = sharedPatch(kp(), m, { input: 1.2, output: 4 });
  assert.equal(paid.needsManualPrice, true, 'non-zero catalog price still needs a human');
  const done = sharedPatch(kp({ allowedModels: [m], rates: { [m]: { input: 0, output: 0, currency: 'USD', free: true, tokenBound: 'utf8-bytes' } } }), m);
  assert.deepEqual(done, { needsManualPrice: false, patch: null });
  const keep = sharedPatch(kp({ allowedModels: ['a/b'] }), m, { input: 0, output: 0 });
  assert.deepEqual(keep.patch.allowedModels, ['a/b', m], 'existing whitelist is preserved');
});
test('model catalog passes through finite catalog prices only', async () => {
  const { buildModelCatalog } = await import('../../engine/model-catalog.mjs');
  const store = { p: { models: [{ id: 'free', cost: { input: 0, output: 0 } }, { id: 'none' }, { id: 'bad', cost: { input: 'x', output: 1 } }] } };
  const list = buildModelCatalog({ store, authed: new Set(['p']) });
  assert.deepEqual(list.find(m => m.id === 'free').cost, { input: 0, output: 0 });
  assert.equal(list.find(m => m.id === 'none').cost, undefined);
  assert.equal(list.find(m => m.id === 'bad').cost, undefined);
});

// 2026-10-07 真机：推理模型 1200 输出额度 + 60 秒超时，持衡首份作业必然截断。
test('grant preset gives reasoning models enough output and time', () => {
  const m = design.permissions.model;
  assert.equal(grantPolicy(design).timeoutMs, mod.GRANT_TIMEOUT_MS);
  assert.ok(mod.GRANT_TIMEOUT_MS >= 120000);
  assert.ok(mod.GRANTABLE_FIELDS.includes('policy.timeoutMs'));
  assert.ok(mod.SHARED_FIELDS.includes('knowledge.outputTokens'));
  const priced = { allowedModels: [m], rates: { [m]: { input: 0, output: 0, currency: 'USD', free: true, tokenBound: 'utf8-bytes' } } };
  assert.equal(sharedPatch(kp({ ...priced, outputTokens: 1200 }), m, undefined, { reasoning: true }).patch.outputTokens, 4096);
  assert.deepEqual(sharedPatch(kp({ ...priced, outputTokens: 1200 }), m, undefined).patch, null, 'non-reasoning keeps owner limit');
  assert.deepEqual(sharedPatch(kp({ ...priced, outputTokens: 4096 }), m, undefined, { reasoning: true }).patch, null);
});
