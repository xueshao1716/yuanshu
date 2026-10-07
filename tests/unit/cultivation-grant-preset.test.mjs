import test from 'node:test';
import assert from 'node:assert/strict';
const mod = await import(new URL('../../frontend/src/soul/cultivation/grant-preset.mjs', import.meta.url));
const { grantPolicy, classifyBlocked, sharedPatch, supportedDesign, grantSummary } = mod;
const design = { permissions: { model: 'stepfun-plan/step-5-preview', tools: [], dataScopes: ['knowledge:approved-cultivation'], remote: false, costUpperBoundCents: 50 } };
const kp = (over = {}) => ({ revision: 3, currency: 'USD', allowedModels: [], rates: {}, ...over });

// 2026-10-07 伙伴要更大额度：14 天、3 个个体、每天 30 次、2 美元、单次 10 分钟；工具与数据范围不放。
test('grant preset matches agreed limits: 14 days, 30 requests/day, $2.00, no tools', () => {
  const now = Date.UTC(2026, 9, 5);
  const p = grantPolicy(design, now);
  assert.equal(p.dailyRequests, 30); assert.equal(p.dailyBudgetCents, 200); assert.equal(p.maxAgents, 3); assert.equal(p.maxConcurrent, 1);
  assert.equal(p.timeoutMs, 600000); assert.equal(p.recursive, false);
  assert.deepEqual(p.tools, []); assert.deepEqual(p.models, [design.permissions.model]);
  assert.deepEqual(p.dataScopes, ['knowledge:approved-cultivation']); assert.equal(p.motherLearning, false);
  assert.equal(Date.parse(p.expiresAt) - now, 14 * 86400000);
  assert.match(grantSummary, /每天 30 次/); assert.match(grantSummary, /2\.00 美元/); assert.match(grantSummary, /3 个个体/);
});
test('designs outside the bounded preset are refused', () => {
  assert.equal(supportedDesign(design), true);
  assert.equal(supportedDesign({ permissions: { ...design.permissions, tools: ['bash'] } }), false);
  assert.equal(supportedDesign({ permissions: { ...design.permissions, costUpperBoundCents: 201 } }), false);
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

// 2026-10-07 真机：持衡已登记、授权已开（60 秒、5 次、0.5 美元、1 个个体），要就地放大而不是重新放权。
test('widenPolicy raises time and quota only, keeps scope, and is idempotent', () => {
  const now = Date.UTC(2026, 9, 7);
  const cur = { enabled: true, maxAgents: 1, maxConcurrent: 1, dailyRequests: 5, dailyBudgetCents: 50, currency: 'USD', allowRemote: true, recursive: false,
    models: ['stepfun-plan/step-5-preview'], tools: [], dataScopes: ['knowledge:approved-cultivation'], motherLearning: false, timeoutMs: 60000,
    expiresAt: new Date(now + 6 * 86400000).toISOString(), schedule: null };
  const w = mod.widenPolicy(cur, now);
  assert.deepEqual(w.changed, ['maxAgents', 'dailyRequests', 'dailyBudgetCents', 'timeoutMs', 'expiresAt']);
  assert.equal(w.policy.timeoutMs, 600000); assert.equal(w.policy.dailyRequests, 30); assert.equal(w.policy.maxAgents, 3);
  for (const k of ['models', 'tools', 'dataScopes', 'motherLearning', 'recursive', 'maxConcurrent', 'allowRemote']) assert.deepEqual(w.policy[k], cur[k], k);
  assert.equal(mod.widenPolicy(w.policy, now), null, 'already widened');
  assert.equal(mod.widenPolicy({ ...cur, enabled: false }, now), null, 'disabled policy goes through the normal grant');
  const bigger = { ...w.policy, dailyRequests: 100, timeoutMs: 600000 };
  assert.equal(mod.widenPolicy(bigger, now), null, 'never lowers a larger grant');
  assert.ok(mod.GRANTABLE_FIELDS.includes('policy.maxAgents'));
});
test('sharedRequestPatch lifts the shared daily model-call cap only when it is lower', () => {
  assert.deepEqual(mod.sharedRequestPatch({ maxModelRequests: 20 }), { maxModelRequests: mod.SHARED_MODEL_REQUESTS });
  assert.equal(mod.sharedRequestPatch({ maxModelRequests: 200 }), null);
  assert.equal(mod.sharedRequestPatch(undefined), null);
});
