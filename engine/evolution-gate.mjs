import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteText, atomicWriteJson } from './atomic-io.mjs';
// 四前提的"任务会重复"要读统一事件流；"验证可自动化"复用自证器的"改动→测试"映射（单一来源，别各写一套）
import { readEvents, classifyTaskType } from './evolution/index.mjs';
import { mapRelatedTests } from './self-change-verify.mjs';

const domains = new Set(['fix-attempt', 'skill-match']);
function statePath(root, domain) {
  if (!domains.has(domain)) throw new Error('unsupported evolution domain');
  return path.join(root, '记忆', '做梦', `evolution-${domain}.json`);
}
// Ignore storage timestamps, but include every effective configuration value.
export function policyFingerprint(value) {
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter(k => k !== 'at').map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function readEvolution(root, domain) {
  try { return JSON.parse(fs.readFileSync(statePath(root, domain), 'utf8')); } catch { return null; }
}
function save(root, state) {
  const file = statePath(root, state.domain);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteText(file, JSON.stringify(state, null, 2));
  return state;
}
const valid = r => r?.covered === true && Number.isFinite(r.score) && Number.isFinite(r.cost) && r.cost >= 0;
const worse = r => !valid(r.baseline) || !valid(r.candidate) || r.candidate.score < r.baseline.score || r.candidate.cost > r.baseline.cost;
const better = r => !worse(r) && (r.candidate.score > r.baseline.score || r.candidate.cost < r.baseline.cost);
const phase = (s, value, reason) => ({ ...s, phase: value, reason });
const evidenceOf = rows => rows.map(r => ({ id: r.id, group: r.group, reference: r.reference || null }));
const lostEvidence = (state, rows) => (state.evidence || []).some(e =>
  !rows.some(r => r.id === e.id && r.group === e.group && (r.reference || null) === e.reference));

// Selection and validation must use exactly the same groups and tie-breaks.
export function evolutionRows(rows, now = new Date()) {
  const ordered = rows.filter(r => r.id && r.group && Number.isFinite(Date.parse(r.at)) && Date.parse(r.at) <= Date.parse(now))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
  return [...new Map(ordered.map(r => [r.group, r])).values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.group.localeCompare(b.group));
}

// Offline comparison never invents model output or spends money. New observations
// must come from real later tasks; repeated task groups cannot refill a holdout.
export function evaluateEvolution(root, { domain, baseline, candidate, rows = [], now = new Date() }) {
  const at = new Date(now).toISOString();
  let state = readEvolution(root, domain);
  const unique = evolutionRows(rows, now);
  const write = s => save(root, { ...s, checkedAt: at });
  if (state && ['canary', 'active', 'rollback_required'].includes(state.phase)) {
    if (policyFingerprint(baseline) !== policyFingerprint(state.candidate))
      return write(phase(state, 'superseded', '现役配置已由其他操作改变，停止自动改动'));
    if (lostEvidence(state, rows)) return write(phase(state, 'rollback_required', '支撑策略的验收证据已失效或撤回，恢复原配置'));
    const fresh = unique.filter(r => Date.parse(r.at) > Date.parse(state.enabledAt));
    if (state.phase === 'rollback_required' || fresh.some(worse) ||
        (state.phase === 'canary' && Date.parse(at) > Date.parse(state.expiresAt)))
      return write(phase(state, 'rollback_required', '后续结果退步、覆盖不足或试运行过期，恢复原配置'));
    return write({ ...state, phase: fresh.length >= 5 ? 'active' : state.phase, monitored: fresh.length,
      evidence: [...(state.evidence || []), ...evidenceOf(fresh).filter(e => !state.evidence?.some(p => p.id === e.id))] });
  }
  if (!state || policyFingerprint(state.baseline) !== policyFingerprint(baseline) ||
      policyFingerprint(state.candidate) !== policyFingerprint(candidate)) {
    state = { schema: 1, domain, baseline, candidate, phase: 'collecting', createdAt: at };
  }
  if (['rejected', 'rolled_back'].includes(state.phase)) return state;
  if (['shadow', 'ready'].includes(state.phase)) {
    if (lostEvidence(state, rows)) return write(phase(state, 'rejected', '支撑候选的验收证据已失效或撤回，需要重新评估'));
    const fresh = unique.filter(r => Date.parse(r.at) > Date.parse(state.shadowAt) && !state.groups.includes(r.group));
    if (fresh.some(worse)) return write(phase(state, 'rejected', '后续真实任务未通过比较'));
    return write({ ...phase(state, fresh.length >= 3 ? 'ready' : 'shadow',
      fresh.length >= 3 ? '保留样本和后续真实任务已通过，等待治理检查' : '等待至少 3 组后续真实任务'), future: fresh.length,
      evidence: [...(state.evidence || []), ...evidenceOf(fresh).filter(e => !state.evidence?.some(p => p.id === e.id))] });
  }
  if (unique.length < 8) return write({ ...phase(state, 'collecting', '至少需要 8 组独立任务（5 组发现、3 组保留验证）'), samples: unique.length });
  const train = unique.slice(0, -3), holdout = unique.slice(-3);
  state = { ...state, train: train.length, holdout: holdout.length, groups: unique.map(r => r.group), evidence: evidenceOf(unique) };
  if (unique.some(worse) || !train.some(better)) return write(phase(state, 'rejected', '发现集无收益或保留样本退步/覆盖不足'));
  return write({ ...phase(state, 'shadow', '历史比较通过，等待后续真实任务'), shadowAt: at, future: 0 });
}

// Called only behind governance on enablement; rollback restores the complete
// previous config, not a guessed default or candidate ID lookup.
export async function activateEvolution(root, { domain, current, apply, now = new Date(), revokeAt }) {
  let state = readEvolution(root, domain);
  if (revokeAt !== undefined) {
    if (!['canary', 'active'].includes(state?.phase) || state.enabledAt !== revokeAt)
      return { ok: false, reason: '该记录不是当前启用的策略，不能撤销其他轮次' };
    state = phase(state, 'rollback_required', '用户撤销本次策略启用');
  }
  const rollback = state?.phase === 'rollback_required';
  if (!rollback && state?.phase !== 'ready') return { ok: false, reason: '证据闸门尚未通过' };
  if (policyFingerprint(current) !== policyFingerprint(rollback ? state.candidate : state.baseline))
    return { ok: false, reason: '现役配置已经变化' };
  const at = new Date(now).toISOString();
  if (revokeAt !== undefined) save(root, state);
  // Persist rollback intent before changing the effective config; retry after a crash is safe.
  if (!rollback) save(root, { ...state, phase: 'rollback_required', reason: '启用尚未完成', enabledAt: at });
  let result;
  try { result = await apply(rollback ? state.baseline : state.candidate); }
  catch (e) { return { ok: false, reason: String(e.message) }; }
  if (result?.ok !== true) { save(root, state); return { ok: false, reason: result?.error || '配置写入失败' }; }
  const next = rollback ? phase(state, 'rolled_back', '已恢复完整原配置') : {
    ...phase(state, 'canary', '受限试运行：5 组后续任务，最多 7 天；退步或覆盖不足即回滚'), enabledAt: at,
    expiresAt: new Date(Date.parse(at) + 7 * 86400000).toISOString(), monitored: 0 };
  save(root, next);
  return { ok: true, phase: next.phase, undo: `evolution:${domain}`, previous: state.baseline };
}

// ═══════════════════════════════════════════════════════════════════════════
// 进化闸门三件套（2026-11-09 从「曦」移植）
//
// 分工（三套别混成一锅）：
//   · self-change-verify / self-change-admit：这套**代码改动对不对**（语法 / import / 测试 / 夹带 / 指纹）
//   · 本节：这次自我改进**值不值得开**（四前提）、改完**有没有真变好**（棘轮）、**谁说了算**（写者判者分离）
//
// 出处：
//   · 四前提 LoopConditions + 判者分离 ≈ xi-system/src/evolution/mod.rs:155-225
//   · 棘轮 RatchetGate（候选 ≥ baseline − 0.02 且零回归）≈ xi-system/src/evolution/gates.rs:42-71
//   · 五维 0-2 分 rubric（≥7 pass）≈ xinyu-zool/evolution/judge.md:10-28
//
// 纪律（照抄元枢现有脾气）：
//   · 不编数：没有证据的维度标 unevaluated，宁可"不算分"，也绝不拿 0 分冒充差评
//   · 不阻断主流程：闸门自己的异常一律 catch 后放行；唯一硬拒绝是"四前提不满足 → 拒提案"
//   · 只追加留痕：判定写 记忆/运行时/进化闸门.jsonl；基线写 记忆/运行时/进化基线.json（人确认才写）
// ═══════════════════════════════════════════════════════════════════════════

/** 五门（曦 GATE_FORMAT / CONTENT / BEHAVIOR / PERFORMANCE / SAFETY）：一份自我改进要过哪几关。 */
export const EVOLUTION_GATES = Object.freeze({
  format: 'format', content: 'content', behavior: 'behavior', performance: 'performance', safety: 'safety',
});

/** 曦 RATCHET_THRESHOLD = 0.7：rubric 满分 10，≥7 才算 pass（judge.md 的 pass 线）。 */
export const RATCHET_THRESHOLD = 0.7;

/** 曦 RatchetGate.noise_tolerance = 0.02：许可的噪声回撤（10 分制里的 0.02 分）。 */
export const RATCHET_NOISE = 0.02;

export const RUBRIC_DIMENSIONS = Object.freeze(['accuracy', 'completeness', 'conciseness', 'safety', 'consistency']);
export const RUBRIC_DIMENSION_LABELS = Object.freeze({
  accuracy: '准确', completeness: '完整', conciseness: '简洁', safety: '安全', consistency: '一致',
});
export const RUBRIC_MAX_PER_DIMENSION = 2;
/** 0-10 分制的 pass 线：RATCHET_THRESHOLD × 10。 */
export const RUBRIC_PASS = 7;

/** 四前提①的阈值：同目标/同类任务历史上至少出现 2 次，才值得开循环。 */
export const LOOP_REPEAT_MIN = 2;

export const LOOP_CONDITION_LABELS = Object.freeze({
  task_repeats: '任务会重复',
  verification_automatable: '验证可自动化',
  token_budget_sufficient: '预算够',
  toolchain_complete: '工具链全',
});

/** 四前提③的默认上限（一次自改循环 ≈ 一次有界 agent 跑）；ctx.budget 可覆盖。 */
export const DEFAULT_BUDGET = Object.freeze({ tokens: 60000, timeMs: 20 * 60 * 1000, rounds: 3 });
/** 提案没给成本估算时的假定值：写进 reason，别当实测。 */
export const DEFAULT_ESTIMATE = Object.freeze({ tokens: 30000, timeMs: 10 * 60 * 1000, rounds: 1 });

export const BASELINE_REL = path.join('记忆', '运行时', '进化基线.json');
export const GATE_LEDGER_REL = path.join('记忆', '运行时', '进化闸门.jsonl');

const EPS = 1e-9;
const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
const clamp2 = (n) => Math.max(0, Math.min(RUBRIC_MAX_PER_DIMENSION, Number(n)));
const minutes = (ms) => `${Math.round(Number(ms) / 60000)} 分钟`;
const toolName = (t) => (typeof t === 'string' ? t : t?.function?.name || t?.name || '');

/** 判定台账：只追加。落 记忆/运行时/（属闸门自身产物，不算 git 夹带改动）。 */
export function appendGateLedger(root, record = {}) {
  const file = path.join(String(root || '.'), GATE_LEDGER_REL);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', 'utf8');
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

export function readGateLedger(root, { limit = 50 } = {}) {
  try {
    return fs.readFileSync(path.join(String(root || '.'), GATE_LEDGER_REL), 'utf8')
      .split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .slice(-Math.max(1, limit)).reverse();
  } catch { return []; }
}

// ── 四前提 ────────────────────────────────────────────────

// 只有这几类事件算"真跑过任务"（proposal/gene 是元数据，不能拿来凑重复次数）。
const WORK_EVENT_KINDS = new Set(['task', 'compare', 'gate', 'observation']);

/** 四前提①的键：优先"同目标"（target:targetId），没有就退到"同类任务"（taskType）。 */
function loopRepeatKey(proposal = {}) {
  const target = String(proposal.target || '').trim();
  const targetId = String(proposal.targetId || '').trim();
  if (target && targetId) return { kind: 'target', key: `${target}:${targetId}` };
  const declared = String(proposal.taskType || '').trim();
  const taskType = declared || classifyTaskType({ text: String(proposal.reason || proposal.hypothesis || ''), files: proposal.files || [] });
  if (taskType && taskType !== '未分类') return { kind: 'taskType', key: taskType };
  return { kind: 'none', key: '' };
}

function countOccurrences(events, keyInfo) {
  const rows = (Array.isArray(events) ? events : []).filter((e) => e && WORK_EVENT_KINDS.has(String(e.kind || '')));
  if (keyInfo.kind === 'target') return rows.filter((e) => `${e.target || ''}:${e.targetId || ''}` === keyInfo.key).length;
  if (keyInfo.kind === 'taskType') return rows.filter((e) => String(e.taskType || '').trim() === keyInfo.key).length;
  return 0;
}

/** 四前提②：改动能不能映射到测试/断言。复用自证器的 mapRelatedTests，不另立一套命名规则。 */
function automationOf(proposal, ctx) {
  const checks = [
    ...(Array.isArray(proposal.checks) ? proposal.checks : []),
    ...(Array.isArray(proposal.assertions) ? proposal.assertions : []),
  ].filter(Boolean);
  const files = [...new Set((Array.isArray(proposal.files) ? proposal.files : []).map((f) => String(f || '').trim()).filter(Boolean))];
  let mapped = { targets: [], uncovered: [] };
  if (files.length) {
    try { mapped = mapRelatedTests({ repoRoot: String(ctx.repoRoot || ctx.wsRoot || '.'), files }); }
    catch (e) { mapped = { targets: [], uncovered: files, error: String(e?.message || e).slice(0, 120) }; }
  }
  const base = { files: files.length, tests: mapped.targets, uncovered: mapped.uncovered, checks: checks.length };
  if (checks.length) return { ok: true, ...base, reason: `声明了 ${checks.length} 条机器可判断言（不用模型判）` };
  if (!files.length) return { ok: false, ...base, reason: '既没有改动文件也没有断言：没法自动判对错，循环只会瞎转' };
  if (!mapped.targets.length) {
    const gap = mapped.uncovered.slice(0, 5).join('、');
    return { ok: false, ...base, reason: `改了 ${files.length} 个文件，但一条相关测试都映射不到（${gap}${mapped.uncovered.length > 5 ? ' 等' : ''}）` };
  }
  if (mapped.uncovered.length) {
    const gap = mapped.uncovered.slice(0, 5).join('、');
    return { ok: false, ...base, reason: `${files.length} 个文件里 ${mapped.uncovered.length} 个无测试覆盖：${gap}${mapped.uncovered.length > 5 ? ' 等' : ''}` };
  }
  return { ok: true, ...base, reason: `${files.length} 个文件都能映射到测试（${mapped.targets.length} 个测试文件）` };
}

/** 四前提③：token/时间/次数三条上限，给出具体数值，不做"看起来够"的判断。 */
function budgetOf(proposal, ctx) {
  const limits = { ...DEFAULT_BUDGET };
  for (const k of ['tokens', 'timeMs', 'rounds']) {
    const v = finite(ctx?.budget?.[k]);
    if (v !== null) limits[k] = v;
  }
  const fromProposal = proposal?.estimate && typeof proposal.estimate === 'object' ? proposal.estimate : null;
  const fromCtx = ctx?.estimate && typeof ctx.estimate === 'object' ? ctx.estimate : null;
  const given = fromProposal || fromCtx;
  const source = fromProposal ? '提案' : fromCtx ? 'ctx' : '默认假定';
  const estimate = {};
  for (const k of ['tokens', 'timeMs', 'rounds']) {
    const v = finite(given?.[k]);
    estimate[k] = v !== null ? v : DEFAULT_ESTIMATE[k];
  }
  const over = [];
  if (estimate.tokens > limits.tokens) over.push(`预计 ${estimate.tokens} tokens 超过上限 ${limits.tokens}`);
  if (estimate.timeMs > limits.timeMs) over.push(`预计 ${minutes(estimate.timeMs)} 超过上限 ${minutes(limits.timeMs)}`);
  if (estimate.rounds > limits.rounds) over.push(`预计 ${estimate.rounds} 轮超过上限 ${limits.rounds} 轮`);
  const head = `预计 ${estimate.tokens} tokens / ${minutes(estimate.timeMs)} / ${estimate.rounds} 轮；上限 ${limits.tokens} tokens / ${minutes(limits.timeMs)} / ${limits.rounds} 轮（成本来源：${source}）`;
  return over.length
    ? { ok: false, reason: `${over.join('；')}（成本来源：${source}）→ 循环会把成本线性放大`, estimate, limits, source, over }
    : { ok: true, reason: head, estimate, limits, source, over: [] };
}

/** 四前提④：所需工具都在 UNIFIED_TOOLS 里。没声明所需工具时按"零依赖"算，但仍要求拿到工具表。 */
function toolchainOf(proposal, ctx) {
  const declared = [
    ...(Array.isArray(proposal.tools) ? proposal.tools : []),
    ...(Array.isArray(proposal.requiresTools) ? proposal.requiresTools : []),
  ].map(toolName).map((t) => String(t || '').trim()).filter(Boolean);
  const required = [...new Set(declared)];
  const rawTools = Array.isArray(ctx?.tools) ? ctx.tools : Array.isArray(ctx?.unifiedTools) ? ctx.unifiedTools : null;
  if (!rawTools) {
    return { ok: false, reason: '没拿到工具表（ctx.tools 应注入 UNIFIED_TOOLS），无法判断工具链是否齐全', required, missing: required, available: null };
  }
  const available = [...new Set(rawTools.map(toolName).map((t) => String(t || '').trim()).filter(Boolean))];
  const missing = required.filter((t) => !available.includes(t));
  if (missing.length) {
    return { ok: false, reason: `缺 ${missing.length} 个工具：${missing.join('、')}（工具表共 ${available.length} 个）`, required, missing, available: available.length };
  }
  return {
    ok: true,
    reason: required.length ? `${required.length} 个所需工具都在（工具表共 ${available.length} 个）` : `未声明所需工具，工具表可用（${available.length} 个）`,
    required, missing: [], available: available.length,
  };
}

/**
 * 四前提（曦 LoopConditions）：缺一条就不许开自我改进循环。
 * @param {object} proposal 提案（files / target / targetId / taskType / reason / checks / tools / estimate / occurrences）
 * @param {object} ctx { wsRoot, repoRoot, events, tools（UNIFIED_TOOLS 名字表或 schema）, budget, estimate, minRepeats, historyLimit }
 * @returns {{ok:boolean, results:object, blockers:string[], checkedAt:string}} results 每项 {ok, reason, …}
 */
export function checkLoopConditions(proposal = {}, ctx = {}) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const minRepeats = finite(c.minRepeats) ?? LOOP_REPEAT_MIN;

  // ① 任务会重复：同目标/同类任务在 run/审计台账里 ≥2 次（一次性任务开循环只烧 token）
  const keyInfo = loopRepeatKey(p);
  let occurrences = finite(p.occurrences) ?? finite(p.repeats);
  let historyNote = '';
  if (occurrences === null) {
    let events = Array.isArray(c.events) ? c.events : null;
    if (!events && c.wsRoot) {
      try { events = readEvents(c.wsRoot, { limit: finite(c.historyLimit) ?? 2000 }); } catch { events = []; }
    }
    if (!events) { events = []; historyNote = '（没给台账，按 0 次算）'; }
    occurrences = countOccurrences(events, keyInfo);
  }
  const repeatsOk = occurrences >= minRepeats;
  const repeatLabel = keyInfo.kind === 'target' ? '同目标' : '同类任务';
  const taskRepeats = {
    ok: repeatsOk,
    reason: keyInfo.kind === 'none'
      ? `没有可统计的键（target:targetId 或 taskType），历史 ${occurrences} 次${historyNote}`
      : repeatsOk
        ? `${repeatLabel} ${keyInfo.key} 历史出现 ${occurrences} 次（≥${minRepeats}）`
        : `${repeatLabel} ${keyInfo.key} 历史只出现 ${occurrences} 次（需 ≥${minRepeats}）${historyNote}`,
    occurrences, minRepeats, key: keyInfo.key, keyKind: keyInfo.kind,
  };

  const results = {
    task_repeats: taskRepeats,
    verification_automatable: automationOf(p, c),
    token_budget_sufficient: budgetOf(p, c),
    toolchain_complete: toolchainOf(p, c),
  };

  const blockers = Object.entries(results)
    .filter(([, r]) => r.ok !== true)
    .map(([k, r]) => `${LOOP_CONDITION_LABELS[k]}：${r.reason}`);

  return { ok: blockers.length === 0, results, blockers, checkedAt: new Date().toISOString() };
}

// ── 棘轮 ──────────────────────────────────────────────────

/**
 * 分数归一化：接受 数字总分 / {total, dimensions} / 扁平 {accuracy:2, …}。
 * unevaluated（null / undefined / "unevaluated"）记进 unknown，绝不折算成 0 分。
 */
export function normalizeScores(input) {
  const empty = { total: null, dimensions: {}, unknown: [] };
  if (input === null || input === undefined) return { ok: false, reason: '没有分数', ...empty };
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, reason: '总分不是有限数', ...empty };
    return { ok: true, total: input, dimensions: {}, unknown: [] };
  }
  if (typeof input !== 'object') return { ok: false, reason: `分数类型不对（${typeof input}）`, ...empty };
  const src = input.dimensions && typeof input.dimensions === 'object' ? input.dimensions : input;
  const dimensions = {};
  const unknown = [];
  for (const id of RUBRIC_DIMENSIONS) {
    const raw = src[id];
    if (raw === undefined || raw === null || raw === 'unevaluated') { unknown.push(id); continue; }
    const score = typeof raw === 'object' ? finite(raw.score) : finite(raw);
    if (score === null) { unknown.push(id); continue; }
    dimensions[id] = score;
  }
  const sum = Object.values(dimensions).reduce((a, b) => a + b, 0);
  const declared = finite(input.total);
  const total = declared !== null ? declared : (Object.keys(dimensions).length ? sum : null);
  if (total === null) return { ok: false, reason: '既没有 total 也没有任何维度分', total: null, dimensions, unknown };
  return { ok: true, total, dimensions, unknown };
}

/**
 * 棘轮闸（曦 RatchetGate.check）：候选 ≥ baseline − threshold **且零回归**才 promote。
 * "零回归"= 基线里有的每一维，候选都得有分且不低于基线；缺分算"证不出来"，不通过。
 * @returns {{ok:boolean, reason:string, deltas:object|null, regressions:string[], unproven:string[]}}
 */
export function ratchetGate({ candidate, baseline, threshold = RATCHET_NOISE } = {}) {
  const tol = finite(threshold);
  const none = { deltas: null, regressions: [], unproven: [] };
  if (tol === null || tol < 0) return { ok: false, reason: `噪声容忍度不合法：${threshold}`, ...none };
  const b = normalizeScores(baseline);
  if (!b.ok) return { ok: false, reason: `基线分数不可用：${b.reason}`, ...none };
  const c = normalizeScores(candidate);
  if (!c.ok) return { ok: false, reason: `候选分数不可用：${c.reason}`, ...none };

  const floor = round3(b.total - tol);
  const totalPass = c.total >= floor - EPS;
  const deltas = {
    total: { baseline: b.total, candidate: c.total, delta: round3(c.total - b.total), floor, pass: totalPass },
    dimensions: {},
  };
  const regressions = [];
  const unproven = [];
  for (const id of RUBRIC_DIMENSIONS) {
    const bv = b.dimensions[id];
    if (bv === undefined) continue; // 基线没打这一维 → 不参与比较
    const cv = c.dimensions[id];
    const row = { baseline: bv, candidate: cv === undefined ? null : cv, delta: cv === undefined ? null : round3(cv - bv), regressed: false };
    if (cv === undefined) { unproven.push(id); row.unproven = true; }
    else if (cv < bv - EPS) { regressions.push(id); row.regressed = true; }
    deltas.dimensions[id] = row;
  }
  const compared = Object.keys(deltas.dimensions).length;
  const ok = totalPass && regressions.length === 0 && unproven.length === 0;
  const names = (ids) => ids.map((id) => `${RUBRIC_DIMENSION_LABELS[id]}(${id})`).join('、');

  let reason;
  if (ok) {
    reason = `候选 ${round3(c.total)} ≥ 基线 ${b.total} − ${tol}（下限 ${floor}），且 ${compared} 维零回归 → promote`;
  } else if (!totalPass) {
    const extra = [regressions.length ? `回归 ${names(regressions)}` : '', unproven.length ? `缺分 ${names(unproven)}` : ''].filter(Boolean).join('；');
    reason = `候选 ${round3(c.total)} < 下限 ${floor}（基线 ${b.total} − ${tol}，差 ${round3(b.total - tol - c.total)}）${extra ? `；另有 ${extra}` : ''} → 不 promote`;
  } else if (regressions.length) {
    reason = `维度回归：${regressions.map((id) => `${id} ${c.dimensions[id]} < ${b.dimensions[id]}`).join('、')} → 不 promote（总分 ${round3(c.total)} 更高也不行）`;
  } else {
    reason = `有 ${unproven.length} 维没有候选分数（${names(unproven)}）：证不出零回归 → 不 promote`;
  }
  return { ok, reason, deltas, regressions, unproven };
}

// ── 写者 / 判者分离 ───────────────────────────────────────

const asWho = (x) => (typeof x === 'string' ? { model: x } : x && typeof x === 'object' ? x : null);
const normModel = (s) => String(s || '').trim().toLowerCase();

/** 判者 prompt（照抄曦 GoalValidator.judge_prompt 的形状）：只判断，不操作，不回工具调用。 */
export function buildJudgePrompt({ condition = '', output = '' } = {}) {
  return `你是验证者（不是执行者）。只判断，不操作。\n完成条件：${condition}\n输出：\n${output}\n回复 JSON：{"pass": true/false, "reason": "简短说明"}`;
}

/**
 * 写者与判者分离（曦 GoalValidator）：不同模型、不同会话、判者零工具。
 * 任一条不满足都直接拒——"自己判自己"不算验证。
 * @param {{writer: object|string, judge: object|string}} input 各含 {model, sessionId, tools}
 */
export function judgeSeparated({ writer, judge } = {}) {
  const w = asWho(writer);
  const j = asWho(judge);
  const violations = [];
  if (!w) violations.push('没有写者身份');
  if (!j) violations.push('没有判者身份');
  const wm = normModel(w?.model);
  const jm = normModel(j?.model);
  if (w && !wm) violations.push('写者没有模型标识，无法证明分离');
  if (j && !jm) violations.push('判者没有模型标识，无法证明分离');
  if (wm && jm && wm === jm) violations.push(`写者与判者是同一模型（${j.model}）：自己判自己不算验证`);

  const ws = String(w?.sessionId || w?.session || '').trim();
  const js = String(j?.sessionId || j?.session || '').trim();
  if (w && j) {
    if (!js) violations.push('判者没有会话标识，无法证明不是同一会话');
    else if (ws && ws === js) violations.push(`写者与判者在同一会话（${js}）：判者会看到写者的推理链`);
  }

  const tools = j?.tools;
  if (j) {
    if (!Array.isArray(tools)) violations.push('判者工具清单不明（必须显式给 tools: []）');
    else if (tools.length) {
      const list = tools.slice(0, 3).map(toolName).filter(Boolean).join('、');
      violations.push(`判者带了 ${tools.length} 个工具（${list}）：判者只读不操作`);
    }
  }

  if (violations.length) return { ok: false, reason: violations.join('；'), violations };
  return {
    ok: true,
    reason: `判者分离成立：写者 ${w.model}@${ws || '?'} ≠ 判者 ${j.model}@${js}，判者零工具`,
    writer: { model: w.model, sessionId: ws },
    judge: { model: j.model, sessionId: js, tools: 0 },
  };
}

// ── rubric 打分（先不接真模型：只吃现成证据）──────────────

function accuracyEvidence(ev) {
  if (Array.isArray(ev.assertions)) {
    const total = ev.assertions.length;
    if (!total) return null;
    const passed = ev.assertions.filter((a) => (typeof a === 'object' ? a?.ok === true : a === true)).length;
    return { rate: passed / total, text: `断言 ${passed}/${total} 通过` };
  }
  if (Array.isArray(ev.commands)) {
    const total = ev.commands.length;
    if (!total) return null;
    const passed = ev.commands.filter((c) => c?.ok === true).length;
    return { rate: passed / total, text: `命令 ${passed}/${total} 通过` };
  }
  if (ev.tests && finite(ev.tests.total) !== null) {
    const total = finite(ev.tests.total);
    if (!total) return null;
    const passed = finite(ev.tests.passed) ?? Math.max(0, total - (finite(ev.tests.failed) ?? 0));
    return { rate: passed / total, text: `测试 ${passed}/${total} 通过` };
  }
  const rate = finite(ev.passRate);
  return rate === null ? null : { rate, text: `通过率 ${rate}` };
}

function completenessEvidence(ev) {
  if (Array.isArray(ev.uncovered)) {
    const n = ev.uncovered.length;
    return n === 0
      ? { score: 2, text: '没有未覆盖文件' }
      : { score: n <= 2 ? 1 : 0, text: `${n} 个文件无测试覆盖` };
  }
  const coverage = finite(ev.coverage);
  if (coverage === null) return null;
  return { score: coverage >= 1 - EPS ? 2 : coverage >= 0.8 ? 1 : 0, text: `覆盖率 ${Math.round(coverage * 100)}%` };
}

function concisenessEvidence(ev) {
  const given = finite(ev.conciseness);
  if (given !== null) return { score: clamp2(given), text: `给定 ${given} 分` };
  const d = ev.diff;
  if (!d || typeof d !== 'object') return null;
  const added = finite(d.added);
  const removed = finite(d.removed);
  if (added === null && removed === null) return null;
  const churn = (added || 0) + (removed || 0);
  const files = finite(d.files);
  return { score: churn <= 80 ? 2 : churn <= 300 ? 1 : 0, text: `改动 +${added || 0} −${removed || 0} 行${files !== null ? `／${files} 个文件` : ''}` };
}

function safetyEvidence(ev) {
  const hits = Array.isArray(ev.protectedHits) ? ev.protectedHits : null;
  const gate = String(ev.gate || ev.gateVerdict || '').toUpperCase();
  const gateScore = gate === 'GREEN' ? 2 : gate === 'YELLOW' ? 1 : gate === 'RED' ? 0 : null;
  if (hits && hits.length) return { score: 0, text: `命中受保护路径 ${hits.length} 处：${hits.slice(0, 3).join('、')}` };
  if (gateScore !== null) return { score: gateScore, text: `交付门 ${gate}${hits ? '，受保护路径 0 命中' : ''}` };
  const given = finite(ev.safety);
  return given === null ? null : { score: clamp2(given), text: `给定 ${given} 分` };
}

function consistencyEvidence(ev) {
  const steps = Array.isArray(ev.steps) ? ev.steps : null;
  if (!steps || !steps.length) return null;
  const wanted = ['syntax', 'import', 'deps'];
  const found = wanted.map((n) => steps.find((s) => s?.name === n)).filter(Boolean);
  if (!found.length) return null;
  const failed = found.filter((s) => s.ok === false).map((s) => s.name);
  if (failed.length) return { score: 0, text: `${failed.join('、')} 失败` };
  const allOk = found.length === wanted.length && found.every((s) => s.ok === true && s.skipped !== true);
  return allOk
    ? { score: 2, text: `${wanted.join('/')} 全过` }
    : { score: 1, text: found.map((s) => `${s.name}=${s.ok === true ? 'ok' : '?'}`).join(' ') };
}

/**
 * 五维 rubric（judge.md）：只吃现成证据，不接模型、不猜。
 * 0-2 分：2=优 1=中 0=差；没有证据的维度 → unevaluated，整体不通过（不是 0 分）。
 * 证据形状（都可缺）：{assertions|commands|tests|passRate, uncovered|coverage, diff|conciseness, gate|protectedHits|safety, steps, dimensions}
 */
export function scoreByRubric(evidence = {}) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {};
  const declared = ev.dimensions && typeof ev.dimensions === 'object' ? ev.dimensions : {};
  const derivations = {
    accuracy: () => { const a = accuracyEvidence(ev); return a ? { score: a.rate >= 1 - EPS ? 2 : a.rate >= 0.9 ? 1 : 0, text: a.text } : null; },
    completeness: () => completenessEvidence(ev),
    conciseness: () => concisenessEvidence(ev),
    safety: () => safetyEvidence(ev),
    consistency: () => consistencyEvidence(ev),
  };
  const dimensions = {};
  const unevaluated = [];
  for (const id of RUBRIC_DIMENSIONS) {
    const given = finite(declared[id]);
    if (given !== null) { dimensions[id] = { score: clamp2(given), reason: '显式给分' }; continue; }
    let got = null;
    try { got = derivations[id](); } catch { got = null; }
    if (got) dimensions[id] = { score: clamp2(got.score), reason: got.text };
    else unevaluated.push(id);
  }
  const total = round3(RUBRIC_DIMENSIONS.reduce((s, id) => s + (dimensions[id]?.score ?? 0), 0));
  const max = RUBRIC_DIMENSIONS.length * RUBRIC_MAX_PER_DIMENSION;
  const ok = unevaluated.length === 0 && total >= RUBRIC_PASS;
  const reason = unevaluated.length
    ? `有 ${unevaluated.length} 维没有证据（${unevaluated.map((id) => RUBRIC_DIMENSION_LABELS[id]).join('、')}）：不算分，整体不通过`
    : ok ? `总分 ${total}/${max} ≥ ${RUBRIC_PASS} → pass` : `总分 ${total}/${max} < ${RUBRIC_PASS} → 不通过`;
  return { ok, total, max, passLine: RUBRIC_PASS, dimensions, unevaluated, reason };
}

// ── 基线（人确认才写）────────────────────────────────────

/** 读基线：没有就 ok:false + reason "未设基线"（调用方据此跳过棘轮，别把"没基线"当"退步"）。 */
export function readBaseline(root) {
  const file = path.join(String(root || '.'), BASELINE_REL);
  if (!fs.existsSync(file)) return { ok: false, reason: '未设基线', path: file };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const n = normalizeScores(raw?.scores);
    if (!n.ok) return { ok: false, reason: `基线文件不可用：${n.reason}`, path: file };
    return { ok: true, path: file, baseline: raw, scores: { total: n.total, dimensions: n.dimensions } };
  } catch (e) {
    return { ok: false, reason: `基线文件读不了：${String(e?.message || e).slice(0, 120)}`, path: file };
  }
}

/**
 * 写基线：首次运行由人确认落盘。approvedBy 必须以 human-confirm: 开头，五维都要 0-2 分。
 * @returns {{ok:boolean, reason?:string, code?:string, path?:string, baseline?:object}}
 */
export function setBaseline({ root, wsRoot, approvedBy = '', scores, note = '', now = Date.now() } = {}) {
  const base = String(root || wsRoot || '.').trim() || '.';
  const approver = String(approvedBy || '').trim();
  if (!/^human-confirm:/i.test(approver)) {
    return { ok: false, code: 'not_human', reason: '基线必须由人确认：approvedBy 要以 "human-confirm:" 开头（例：human-confirm:小语）' };
  }
  const n = normalizeScores(scores);
  if (!n.ok) return { ok: false, code: 'bad_scores', reason: `基线分数不可用：${n.reason}` };
  if (n.unknown.length) {
    return {
      ok: false, code: 'missing_dimensions',
      reason: `基线缺维度：${n.unknown.map((id) => RUBRIC_DIMENSION_LABELS[id]).join('、')}（五维都要 0-2 分，否则零回归无法逐维判定）`,
      missing: n.unknown,
    };
  }
  const baseline = {
    schema: 1,
    at: new Date(now).toISOString(),
    approvedBy: approver,
    scores: { total: n.total, dimensions: n.dimensions },
    note: String(note || '').slice(0, 200),
  };
  const file = path.join(base, BASELINE_REL);
  try { atomicWriteJson(file, baseline); }
  catch (e) { return { ok: false, code: 'write_failed', reason: `基线写盘失败：${String(e?.message || e).slice(0, 160)}` }; }
  return { ok: true, path: file, baseline };
}

/** 自证判决 → rubric 输入：只用真跑过的证据，不替它补分。 */
export function evidenceFromVerdict(verdict, files = []) {
  const v = verdict && typeof verdict === 'object' ? verdict : {};
  const source = Array.isArray(files) && files.length ? files : Array.isArray(v.files) ? v.files : [];
  const ev = { files: [...new Set(source.map(String))] };
  if (Array.isArray(v.steps)) ev.steps = v.steps;
  const uncovered = Array.isArray(v.evidence?.uncovered) ? v.evidence.uncovered
    : Array.isArray(v.evidence?.tests?.uncovered) ? v.evidence.tests.uncovered
      : Array.isArray(v.uncovered) ? v.uncovered : null;
  if (uncovered) ev.uncovered = uncovered;
  if (Array.isArray(v.evidence?.commands) && v.evidence.commands.length) ev.commands = v.evidence.commands;
  const gate = v.gate?.verdict || v.gateVerdict || v.deliveryGate || '';
  if (gate) ev.gate = gate;
  return ev;
}

/**
 * 准入前的棘轮：无基线 → 跳过 + 留痕（不阻断）；有基线但候选缺证据 → 跳过 + 留痕（不阻断）；
 * 有基线且候选五维都有分 → 逐维比，回归就挡（enforce:false 则只留痕）。
 * @returns {{ok:boolean, skipped?:boolean, enforced:boolean, blocked?:boolean, gate?:object, reason:string, recorded:boolean}}
 */
export function gateBeforeAdmit({ wsRoot, files = [], verdict, candidate, enforce = true, now = Date.now(), note = '' } = {}) {
  const root = String(wsRoot || '.');
  const log = (kind, extra = {}) => {
    const r = appendGateLedger(root, {
      kind, at: new Date(now).toISOString(), note: String(note || '').slice(0, 160),
      files: (Array.isArray(files) ? files : []).slice(0, 8), ...extra,
    });
    return r.ok === true;
  };

  let base;
  try { base = readBaseline(root); }
  catch (e) { base = { ok: false, reason: `读基线异常：${String(e?.message || e).slice(0, 120)}` }; }
  if (!base.ok) {
    const reason = base.reason === '未设基线'
      ? '未设基线：棘轮跳过（不阻断，已留痕）'
      : `${base.reason}：棘轮跳过（不阻断，已留痕）`;
    return { ok: true, skipped: true, enforced: false, reason, recorded: log('ratchet_no_baseline', { detail: base.reason || '' }) };
  }

  let scores = candidate;
  if (!scores) {
    try {
      const s = scoreByRubric(evidenceFromVerdict(verdict, files));
      scores = {
        total: s.total,
        dimensions: Object.fromEntries(Object.entries(s.dimensions).map(([k, v]) => [k, v.score])),
        unevaluated: s.unevaluated,
      };
    } catch (e) {
      const detail = String(e?.message || e).slice(0, 120);
      return { ok: true, skipped: true, enforced: false, reason: `算分异常（不阻断）：${detail}`, recorded: log('ratchet_error', { detail }) };
    }
  }
  const n = normalizeScores(scores);
  if (!n.ok) {
    return { ok: true, skipped: true, enforced: false, reason: `候选分数不可用（不阻断）：${n.reason}`, recorded: log('ratchet_no_score', { detail: n.reason }) };
  }
  if (n.unknown.length) {
    const unrated = n.unknown;
    const reason = `证据不足：${unrated.map((id) => RUBRIC_DIMENSION_LABELS[id]).join('、')} 没有分数，棘轮跳过（不阻断，已留痕）`;
    return { ok: true, skipped: true, enforced: false, unrated, reason, recorded: log('ratchet_unrated', { unrated, total: n.total }) };
  }

  const gate = ratchetGate({ candidate: scores, baseline: base.scores });
  const blocked = enforce && !gate.ok;
  const reason = gate.ok ? gate.reason : `${gate.reason}${enforce ? '' : '（enforce:false，只留痕不阻断）'}`;
  return {
    ok: !blocked, skipped: false, enforced: enforce, blocked, gate, reason,
    baselineAt: base.baseline?.at || '', baselineApprovedBy: base.baseline?.approvedBy || '',
    recorded: log(gate.ok ? 'ratchet_pass' : 'ratchet_fail', {
      reason: gate.reason, total: gate.deltas?.total || null, regressions: gate.regressions || [],
    }),
  };
}

// ── 评估器闸：严格更高才接受（2026-11-09）──────────────────────

/**
 * 评估器棘轮（建在 ratchetGate 之上）：参考分来自 evaluator.bestScore 的历史最高分，
 * 候选必须**严格大于**参考分（同分不接受）、且 ratchetGate 逐维零回归，才 promote。
 * 与 gateBeforeAdmit 的分工：那个用"人确认的基线 + 噪声容忍"，这个用"历史最高分 + 严格递增"。
 * enabled:false → 整体跳过（回退开关；也可用环境变量 YUANSHU_EVALUATOR=off）。
 * 评估器自己出异常一律不阻断（元枢纪律），返回 skipped。
 * @param {{enabled?:boolean, wsRoot?:string, kind?:string, artifact?:object, rubric?:object,
 *          judge?:object, writer?:object, threshold?:number, dryRun?:boolean}} options
 */
export async function evaluatorRatchet({ enabled = true, ...rest } = {}) {
  if (enabled === false) {
    return { ok: true, skipped: true, enabled: false, accepted: false, reason: '评估器闸已关闭（enabled:false），按回退路径放行' };
  }
  let mod;
  try {
    // 动态 import：evaluator.mjs 静态依赖本模块（RUBRIC_* + ratchetGate），静态互相 import 会成环。
    mod = await import('./evaluator.mjs');
  } catch (e) {
    return { ok: true, skipped: true, reason: `评估器加载失败（不阻断）：${String(e?.message || e).slice(0, 160)}` };
  }
  try {
    const out = mod.evaluateWithRatchet({ enabled: true, ...rest });
    return { ...out, skipped: out.skipped === true };
  } catch (e) {
    return { ok: true, skipped: true, reason: `评估器异常（不阻断）：${String(e?.message || e).slice(0, 160)}` };
  }
}
