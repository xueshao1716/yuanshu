import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateEvolution, activateEvolution, readEvolution } from '../../engine/evolution-gate.mjs';
// 2026-11-09：进化闸门三件套（四前提 / 棘轮 / 判者分离 / rubric / 基线）
import {
  checkLoopConditions, ratchetGate, judgeSeparated, buildJudgePrompt, scoreByRubric,
  setBaseline, readBaseline, gateBeforeAdmit, readGateLedger, evidenceFromVerdict,
  RUBRIC_PASS, RATCHET_NOISE, LOOP_REPEAT_MIN,
} from '../../engine/evolution-gate.mjs';

const baseline = { id: 'old', retryOnFailure: 2 };
const candidate = { id: 'new', retryOnFailure: 1 };
const historical = Array.from({ length: 8 }, (_, i) => ({ id: `h${i}`, group: `task${i}`,
  at: '2026-09-20T00:00:00Z', baseline: { score: 0, cost: 3, covered: true }, candidate: { score: 0, cost: 2, covered: true } }));
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const options = { domain: 'fix-attempt', baseline, candidate, rows: historical, now: '2026-09-21T00:00:00Z' };
const later = Array.from({ length: 3 }, (_, i) => ({ ...historical[i], id: `f${i}`, group: `fresh${i}`, at: '2026-09-22T00:00:00Z' }));

test('history only stages shadow, repeated task groups cannot satisfy holdout', t => {
  const root = setup(t);
  assert.equal(evaluateEvolution(root, { ...options, rows: historical.map(r => ({ ...r, group: 'same' })) }).phase, 'collecting');
  const s = evaluateEvolution(root, options);
  assert.equal(s.phase, 'shadow');
  assert.equal(s.holdout, 3);
  assert.equal(evaluateEvolution(root, options).phase, 'shadow');
});

test('new real groups qualify; enablement preserves exact rollback config; regression rolls back', async t => {
  const root = setup(t);
  evaluateEvolution(root, options);
  const ready = evaluateEvolution(root, { ...options, rows: [...historical, ...later], now: '2026-09-23T00:00:00Z' });
  assert.equal(ready.phase, 'ready');
  let applied;
  await activateEvolution(root, { domain: 'fix-attempt', current: baseline, apply: async p => { applied = p; return { ok: true }; }, now: '2026-09-23T00:00:00Z' });
  assert.deepEqual(applied, candidate);
  const bad = { ...later[0], id: 'bad', group: 'new-bad', at: '2026-09-24T00:00:00Z', candidate: { score: 0, cost: 1, covered: false } };
  const s = evaluateEvolution(root, { ...options, baseline: candidate, rows: [bad], now: '2026-09-24T01:00:00Z' });
  assert.equal(s.phase, 'rollback_required');
  await activateEvolution(root, { domain: 'fix-attempt', current: candidate, apply: async p => { applied = p; return { ok: true }; } });
  assert.deepEqual(applied, baseline);
  assert.equal(readEvolution(root, 'fix-attempt').phase, 'rolled_back');
});

test('failed write and changed baseline never report enabled', async t => {
  const root = setup(t);
  evaluateEvolution(root, options);
  evaluateEvolution(root, { ...options, rows: [...historical, ...later], now: '2026-09-23T00:00:00Z' });
  assert.equal((await activateEvolution(root, { domain: 'fix-attempt', current: { ...baseline, retryOnFailure: 3 }, apply: () => assert.fail() })).ok, false);
  assert.equal((await activateEvolution(root, { domain: 'fix-attempt', current: baseline, apply: async () => ({ ok: false }) })).ok, false);
  assert.equal(readEvolution(root, 'fix-attempt').phase, 'ready');
});

test('holdout regressions and unsupported branches block promotion', t => {
  const root = setup(t);
  const rows = historical.map((r, i) => i === 7 ? { ...r, candidate: { ...r.candidate, covered: false } } : r);
  assert.equal(evaluateEvolution(root, { ...options, rows }).phase, 'rejected');
});

test('future-dated observations cannot advance the gate', t => {
  const root = setup(t);
  evaluateEvolution(root, options);
  assert.equal(evaluateEvolution(root, { ...options, rows: [...historical, ...later] }).phase, 'shadow');
});

test('manual rollback is bound to the exact enablement', async t => {
  const root = setup(t);
  evaluateEvolution(root, options);
  evaluateEvolution(root, { ...options, rows: [...historical, ...later], now: '2026-09-23T00:00:00Z' });
  const enabledAt = '2026-09-23T01:00:00Z';
  await activateEvolution(root, { domain: 'fix-attempt', current: baseline, now: enabledAt, apply: async () => ({ ok: true }) });
  assert.equal((await activateEvolution(root, { domain: 'fix-attempt', current: candidate,
    revokeAt: 'old-enablement', apply: () => assert.fail('stale revoke must not write') })).ok, false);
  let applied;
  const r = await activateEvolution(root, { domain: 'fix-attempt', current: candidate, revokeAt: new Date(enabledAt).toISOString(),
    apply: async p => { applied = p; return { ok: true }; } });
  assert.equal(r.ok, true);
  assert.equal(r.phase, 'rolled_back');
  assert.deepEqual(applied, baseline);
});

// ═══════════════════════════════════════════════════════════════════════════
// 进化闸门三件套（2026-11-09 从「曦」移植）
// 四前提 / 棘轮 / 判者分离 / rubric / 基线：全程临时目录 + 注入证据，不碰真实台账
// ═══════════════════════════════════════════════════════════════════════════

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '..', '..');
const DIMS = { accuracy: 2, completeness: 2, conciseness: 2, safety: 2, consistency: 1 };
const baselineScores = { total: 9, dimensions: { ...DIMS } };

/** 临时"代码仓"：造一个改动文件 + 可选的相关测试（mapRelatedTests 按文件名映射）。 */
function repoFixture(t, { files = ['engine/foo.mjs'], withTest = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-loop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const f of files) {
    const abs = path.join(root, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  }
  if (withTest) {
    fs.mkdirSync(path.join(root, 'tests/unit'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/unit/foo.test.mjs'), '// test\n', 'utf8');
  }
  return root;
}

const evt = (over = {}) => ({ kind: 'compare', target: 'skill', targetId: 'py', taskType: 'coding',
  verdict: 'rollback', at: '2026-11-01T00:00:00Z', ...over });
const baseProposal = () => ({ target: 'skill', targetId: 'py', files: ['engine/foo.mjs'],
  estimate: { tokens: 12000, timeMs: 5 * 60 * 1000, rounds: 1 } });
const baseCtx = (root, extra = {}) => ({ wsRoot: root, repoRoot: root,
  events: [evt(), evt()], tools: ['bash', 'read', 'delivery_check'], ...extra });

test('四前提：四条全满足才 ok（缺一条都不开循环）', t => {
  const root = repoFixture(t);
  const out = checkLoopConditions(baseProposal(), baseCtx(root));
  assert.equal(out.ok, true);
  assert.deepEqual(out.blockers, []);
  assert.deepEqual(Object.keys(out.results), ['task_repeats', 'verification_automatable', 'token_budget_sufficient', 'toolchain_complete']);
  for (const r of Object.values(out.results)) {
    assert.equal(r.ok, true);
    assert.ok(r.reason && r.reason.length > 0);
  }
  assert.equal(out.results.task_repeats.occurrences, 2);
  assert.ok(out.results.token_budget_sufficient.reason.includes('12000'));
});

test('四前提①：同目标只出现 1 次 → 挡，理由说明出现次数', t => {
  const root = repoFixture(t);
  const out = checkLoopConditions(baseProposal(), baseCtx(root, { events: [evt()] }));
  assert.equal(out.ok, false);
  assert.equal(out.results.task_repeats.ok, false);
  assert.match(out.results.task_repeats.reason, /1 次/);
  assert.match(out.results.task_repeats.reason, new RegExp(`≥${LOOP_REPEAT_MIN}`));
  assert.ok(out.blockers.some((b) => b.startsWith('任务会重复')));
  // 其余三条仍然各自给出结论，不互相带偏
  assert.equal(out.results.verification_automatable.ok, true);
  assert.equal(out.results.token_budget_sufficient.ok, true);
  assert.equal(out.results.toolchain_complete.ok, true);
});

test('四前提①：元数据事件（proposal/observation 之外）不能凑重复次数', t => {
  const root = repoFixture(t);
  const out = checkLoopConditions(baseProposal(), baseCtx(root, { events: [evt({ kind: 'proposal' }), evt({ kind: 'proposal' })] }));
  assert.equal(out.results.task_repeats.ok, false);
  assert.equal(out.results.task_repeats.occurrences, 0);
});

test('四前提①：只给 wsRoot 时从统一事件流台账统计（真读文件）', t => {
  const root = setup(t);
  const dir = path.join(root, '记忆', '运行时', '进化');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    [evt(), evt(), evt({ kind: 'proposal' })].map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const out = checkLoopConditions({ target: 'skill', targetId: 'py', checks: [{ name: '断言 1' }],
    estimate: { tokens: 1000 } }, { wsRoot: root, tools: [] });
  assert.equal(out.ok, true);
  assert.equal(out.results.task_repeats.occurrences, 2);
});

test('四前提②：没有测试覆盖 → 挡；声明了机器断言 → 过', t => {
  const root = repoFixture(t, { withTest: false });
  const noCover = checkLoopConditions(baseProposal(), baseCtx(root));
  assert.equal(noCover.results.verification_automatable.ok, false);
  assert.match(noCover.results.verification_automatable.reason, /映射不到|无测试覆盖/);
  assert.ok(noCover.blockers.some((b) => b.startsWith('验证可自动化')));

  const noFiles = checkLoopConditions({ target: 'skill', targetId: 'py', estimate: { tokens: 1000 } }, baseCtx(root));
  assert.equal(noFiles.results.verification_automatable.ok, false);
  assert.match(noFiles.results.verification_automatable.reason, /既没有改动文件也没有断言/);

  const withChecks = checkLoopConditions({ ...baseProposal(), checks: [{ name: 'foo 返回 1' }] }, baseCtx(root));
  assert.equal(withChecks.results.verification_automatable.ok, true);
  assert.match(withChecks.results.verification_automatable.reason, /1 条机器可判断言/);
});

test('四前提③：预估超上限 → 挡，理由给具体数值；抬上限可放行', t => {
  const root = repoFixture(t);
  const over = checkLoopConditions({ ...baseProposal(), estimate: { tokens: 90000 } }, baseCtx(root));
  assert.equal(over.results.token_budget_sufficient.ok, false);
  assert.match(over.results.token_budget_sufficient.reason, /90000/);
  assert.match(over.results.token_budget_sufficient.reason, /60000/);

  const raised = checkLoopConditions({ ...baseProposal(), estimate: { tokens: 90000 } },
    baseCtx(root, { budget: { tokens: 120000 } }));
  assert.equal(raised.results.token_budget_sufficient.ok, true);

  const noEstimate = checkLoopConditions({ ...baseProposal(), estimate: undefined }, baseCtx(root));
  assert.equal(noEstimate.results.token_budget_sufficient.ok, true);
  assert.match(noEstimate.results.token_budget_sufficient.reason, /默认假定/);
});

test('四前提④：所需工具不在工具表里 → 挡；工具表没注入也算不满足', t => {
  const root = repoFixture(t);
  const missing = checkLoopConditions({ ...baseProposal(), tools: ['no_such_tool'] }, baseCtx(root));
  assert.equal(missing.results.toolchain_complete.ok, false);
  assert.match(missing.results.toolchain_complete.reason, /no_such_tool/);
  assert.ok(missing.blockers.some((b) => b.startsWith('工具链全')));

  const noTable = checkLoopConditions(baseProposal(), baseCtx(root, { tools: undefined }));
  assert.equal(noTable.results.toolchain_complete.ok, false);
  assert.match(noTable.results.toolchain_complete.reason, /工具表/);
});

test('棘轮：候选 = 基线 − 0.01 通过（噪声容忍 0.02）', () => {
  const r = ratchetGate({ baseline: baselineScores, candidate: { total: 8.99, dimensions: { ...DIMS } } });
  assert.equal(r.ok, true);
  assert.equal(r.deltas.total.delta, -0.01);
  assert.equal(r.deltas.total.floor, 8.98);
  assert.deepEqual(r.regressions, []);
  assert.match(r.reason, /promote/);
});

test('棘轮：候选 = 基线 − 0.03 不通过，理由带具体数值', () => {
  const r = ratchetGate({ baseline: baselineScores, candidate: { total: 8.97, dimensions: { ...DIMS } } });
  assert.equal(r.ok, false);
  assert.equal(r.deltas.total.pass, false);
  assert.match(r.reason, /8\.97/);
  assert.match(r.reason, /下限 8\.98/);
});

test('棘轮：任一维回归不通过（哪怕总分更高）', () => {
  const r = ratchetGate({ baseline: baselineScores,
    candidate: { total: 9, dimensions: { ...DIMS, safety: 1 } } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.regressions, ['safety']);
  assert.equal(r.deltas.total.pass, true, '总分是过线的');
  assert.equal(r.deltas.dimensions.safety.regressed, true);
  assert.match(r.reason, /维度回归/);
});

test('棘轮：候选缺某一维 → 不通过（证不出零回归）', () => {
  const r = ratchetGate({ baseline: baselineScores,
    candidate: { total: 9, dimensions: { accuracy: 2, completeness: 2, conciseness: 2, safety: 2 } } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unproven, ['consistency']);
  assert.match(r.reason, /零回归/);
});

test('棘轮：没有基线/候选分数 → 直接拒，不编分', () => {
  assert.equal(ratchetGate({ candidate: { total: 9 } }).ok, false);
  assert.equal(ratchetGate({ baseline: baselineScores }).ok, false);
  assert.match(ratchetGate({ baseline: baselineScores }).reason, /候选分数不可用/);
});

test('判者分离：同一模型（大小写不同也算）→ 拒', () => {
  const r = judgeSeparated({
    writer: { model: 'deepseek-flash', sessionId: 'w1' },
    judge: { model: 'DeepSeek-Flash', sessionId: 'j1', tools: [] },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /同一模型/);
});

test('判者分离：同一会话 → 拒', () => {
  const r = judgeSeparated({
    writer: { model: 'deepseek-flash', sessionId: 's1' },
    judge: { model: 'glm-5.3', sessionId: 's1', tools: [] },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /同一会话/);
});

test('判者分离：判者带工具 / 工具清单不明 → 各拒一次', () => {
  const withTools = judgeSeparated({
    writer: { model: 'deepseek-flash', sessionId: 'w1' },
    judge: { model: 'glm-5.3', sessionId: 'j1', tools: ['bash'] },
  });
  assert.equal(withTools.ok, false);
  assert.match(withTools.reason, /带了 1 个工具/);

  const noList = judgeSeparated({
    writer: { model: 'deepseek-flash', sessionId: 'w1' },
    judge: { model: 'glm-5.3', sessionId: 'j1' },
  });
  assert.equal(noList.ok, false);
  assert.match(noList.reason, /工具清单不明/);
});

test('判者分离：不同模型 + 不同会话 + 零工具 → 通过；judge prompt 声明"只判断不操作"', () => {
  const r = judgeSeparated({
    writer: { model: 'deepseek-flash', sessionId: 'w1' },
    judge: { model: 'glm-5.3', sessionId: 'j1', tools: [] },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, undefined);
  const prompt = buildJudgePrompt({ condition: '测试全过', output: '4 passed' });
  assert.match(prompt, /你是验证者（不是执行者）/);
  assert.match(prompt, /"pass"/);
});

test('rubric：证据齐 → 五维都算分且过线', () => {
  const r = scoreByRubric({
    commands: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
    uncovered: [],
    diff: { added: 40, removed: 10, files: 2 },
    gate: 'GREEN',
    steps: [{ name: 'syntax', ok: true }, { name: 'import', ok: true }, { name: 'deps', ok: true }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.total, 10);
  assert.equal(r.passLine, RUBRIC_PASS);
  assert.deepEqual(r.unevaluated, []);
  assert.equal(r.dimensions.accuracy.score, 2);
  assert.equal(r.dimensions.conciseness.score, 2);
});

test('rubric：缺证据的维度标 unevaluated，整体不通过（不拿 0 分冒充差评）', () => {
  const r = scoreByRubric({ steps: [{ name: 'syntax', ok: true }, { name: 'import', ok: true }, { name: 'deps', ok: true }] });
  assert.equal(r.dimensions.consistency.score, 2);
  assert.ok(r.unevaluated.includes('accuracy'));
  assert.ok(r.unevaluated.includes('conciseness'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有证据/);
});

test('rubric：总分够但仍有维度缺证 → 不通过', () => {
  const r = scoreByRubric({
    dimensions: { accuracy: 2, completeness: 2, conciseness: 2, safety: 2 },
    steps: [],
  });
  assert.equal(r.total, 8);
  assert.ok(r.total >= RUBRIC_PASS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unevaluated, ['consistency']);
});

test('基线：必须人确认（human-confirm:）+ 五维齐全才写得进去', t => {
  const root = setup(t);
  assert.equal(setBaseline({ root, approvedBy: '小语', scores: DIMS }).code, 'not_human');
  assert.equal(setBaseline({ root, approvedBy: 'human-confirm:小语', scores: { accuracy: 2 } }).code, 'missing_dimensions');
  assert.equal(readBaseline(root).ok, false);
  assert.equal(readBaseline(root).reason, '未设基线');

  const wrote = setBaseline({ root, approvedBy: 'human-confirm:小语', scores: DIMS });
  assert.equal(wrote.ok, true);
  const read = readBaseline(root);
  assert.equal(read.ok, true);
  assert.equal(read.scores.total, 9);
  assert.equal(read.baseline.approvedBy, 'human-confirm:小语');
});

test('准入前棘轮：未设基线 → 跳过 + 留痕，不阻断', t => {
  const root = setup(t);
  const r = gateBeforeAdmit({ wsRoot: root, files: ['engine/foo.mjs'], verdict: { steps: [] } });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.recorded, true);
  assert.match(r.reason, /未设基线/);
  const rows = readGateLedger(root);
  assert.equal(rows[0].kind, 'ratchet_no_baseline');
});

test('准入前棘轮：有基线 + 候选有分且回归 → 挡住；enforce:false 只留痕', t => {
  const root = setup(t);
  setBaseline({ root, approvedBy: 'human-confirm:小语', scores: DIMS });
  const candidate = { total: 9, dimensions: { ...DIMS, consistency: 0.5 } };
  const blocked = gateBeforeAdmit({ wsRoot: root, files: ['engine/foo.mjs'], candidate });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /维度回归/);
  assert.equal(readGateLedger(root)[0].kind, 'ratchet_fail');

  const soft = gateBeforeAdmit({ wsRoot: root, files: ['engine/foo.mjs'], candidate, enforce: false });
  assert.equal(soft.ok, true);
  assert.equal(soft.blocked, false);
  assert.match(soft.reason, /enforce:false/);
});

test('准入前棘轮：候选证据不全 → 跳过（不拿缺证据当退步）', t => {
  const root = setup(t);
  setBaseline({ root, approvedBy: 'human-confirm:小语', scores: DIMS });
  const r = gateBeforeAdmit({ wsRoot: root, files: ['engine/foo.mjs'], verdict: { steps: [{ name: 'syntax', ok: true }] } });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.ok(Array.isArray(r.unrated) && r.unrated.length > 0);
  assert.equal(readGateLedger(root)[0].kind, 'ratchet_unrated');
});

test('自证判决 → rubric 证据：只取真跑过的字段', () => {
  const ev = evidenceFromVerdict({
    steps: [{ name: 'tests', ok: true, skipped: false }],
    evidence: { uncovered: [], commands: [{ ok: true }], tests: { uncovered: [] } },
    gate: { verdict: 'GREEN' },
  }, ['engine/foo.mjs']);
  assert.deepEqual(ev.uncovered, []);
  assert.equal(ev.gate, 'GREEN');
  assert.equal(ev.commands.length, 1);
  assert.equal(ev.files[0], 'engine/foo.mjs');
  const scored = scoreByRubric(ev);
  assert.equal(scored.dimensions.safety.score, 2);
  assert.ok(scored.unevaluated.includes('conciseness'), '没有 diff 证据 → 简洁性必须是 unevaluated');
});

test('接线：self-change 提案阶段确实调用 checkLoopConditions（两条路由都带 ctx）', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'engine/self-change.mjs'), 'utf8');
  const body = src.slice(src.indexOf('export function makeProposal'), src.indexOf('export function recordProposal'));
  assert.match(body, /checkLoopConditions\s*\(/);
  assert.match(body, /if \(ctx\)/);
  assert.match(body, /四前提不满足/);

  const server = fs.readFileSync(path.join(REPO_ROOT, 'server.mjs'), 'utf8');
  const calls = (server.match(/makeProposal\(\{[^}]*\}/g) || []);
  assert.ok(calls.length >= 2, '两条提案路由都要调 makeProposal');
  assert.ok(calls.every((c) => /ctx:\s*selfChangeLoopCtx\(/.test(c)), '提案路由必须把四前提证据注入 ctx');
  assert.match(server, /function selfChangeLoopCtx\(/);
});

test('接线：admit 之前在 git add 之前调用棘轮', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'engine/self-change-admit.mjs'), 'utf8');
  const body = src.slice(src.indexOf('export async function admit'));
  const gate = body.indexOf('gateBeforeAdmit(');
  const add = body.indexOf('"add"');
  assert.ok(gate > 0, 'admit 里必须调 gateBeforeAdmit');
  assert.ok(add > gate, '棘轮必须在 git add 之前跑');
  assert.match(body.slice(gate, gate + 300), /ratchet/);
  assert.match(body, /reject\("ratchet"/);
});
