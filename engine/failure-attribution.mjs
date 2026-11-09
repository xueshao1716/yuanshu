// ===== failure-attribution.mjs —— 失败归因：哪些失败值得改，哪些改了也白改（2026-11-09）=====
//
// 出处：xinyu-hermes/replay_writer.py:31-38 —— 它把失败分四类，并且**只把两类当可改进信号**。
// 元枢的病：失败台账（failure-ledger.mjs）只记「这条路走不通」，不判「这条失败是不是可改进」，
// 于是"任务本来不可能""工具不够"和"技能没照做""技能缺一条"混在一个桶里，
// 改进队列全是噪声，真该改的那条反而被埋了。
//
// 四类（只有后两类 isSignal:true）：
//   task_impossible     任务本身做不到 / 环境不允许，重试也白搭
//   tool_insufficient   工具/手段不够：换工具、装依赖、换 API 能过（**重试成功**是最硬的证据）
//   skill_noncompliant  有技能，但没按技能执行（跳过步骤 / 违反规范）
//   skill_knowledge_gap 有技能/知识，但缺关键那一条（技能没写、知识没记）
//
// 纪律：判定只用台账里已有的真实字段——失败原因文本、是否重试后成功、
// 同一命令是否多次因环境失败、是否命中对应技能/知识条目；不猜。
// 证据不足就低置信（confidence），并带 evidence 说明，便于人复核（别把"判不出"伪装成"判准了"）。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./atomic-io.mjs";
import { LESSON_LEDGER, LESSON_CAP, lessonSimilarity, SIMILAR_MIN } from "./lesson-promotion.mjs";

export const FAILURE_KINDS = Object.freeze([
  "task_impossible",
  "tool_insufficient",
  "skill_noncompliant",
  "skill_knowledge_gap",
]);
export const SIGNAL_KINDS = Object.freeze(["skill_noncompliant", "skill_knowledge_gap"]);
export const KIND_LABELS = Object.freeze({
  task_impossible: "任务不可能",
  tool_insufficient: "工具不够",
  skill_noncompliant: "技能没照做",
  skill_knowledge_gap: "技能缺知识",
});
/** 相似失败合并阈值：≥0.85 视为同一条（参考 hermes replay_writer 的 --prune 口径）。 */
export const DEDUPE_THRESHOLD = 0.85;
/** 同一命令因环境失败到这个数（与 failure-ledger.IMPOSSIBLE_THRESHOLD 一致）→ 判环境不允许。 */
export const ENV_IMPOSSIBLE_THRESHOLD = 3;
export const IMPROVEMENT_QUEUE_REL = path.join("记忆", "运行时", "改进队列.json");
export const MAX_QUEUE = 200;

// ── 证据正则（全部是"失败原因文本里真出现过的说法"）──────────────────

/** 环境/基础设施造成的失败：换手段能绕，但同一命令反复这样就别试了。 */
const ENV_RE = /ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|not found|找不到|命令不存在|未安装|没有安装|is not recognized|不是内部或外部命令|权限不足|无权限|拒绝访问|超时|timeout|timed out|网络|断网|离线|DNS|429|502|503|504|限流|额度|磁盘|空间不足|内存不足|OOM|out of memory|端口|被占用|被锁|locked/i;
/** 工具/手段层面的缺失：不是环境，是"手里没有这个家伙"。 */
const TOOL_RE = /工具|tool[s]?\b|命令|CLI|API|接口|插件|依赖|dependency|missing|未提供|不支持|没有这个功能|装不上|需要安装|npm install|pip install|skill 未加载/i;
/** 技能在手却没照做。 */
const NONCOMPLIANT_RE = /没按|没有按|未按|不按|没有照|没照|未照|违反|违背|跳过|跳了|漏了|漏掉|擅自|忽略|未执行|没有执行|没执行|未使用|没用上|step\s*\d+|步骤\s*\d+|规范|应当|本该/i;
/** 技能/知识里缺这一条。 */
const GAP_RE = /没写|未写|没有写|缺少|缺失|未覆盖|没有覆盖|未记录|没有记录|不知道|不清楚|不会|没有说明|未说明|没有相关|无此|知识不足|技能里没有|文档缺失/i;

const EPS = 1e-9;
const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
const clean = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const textOf = (e) => `${e?.area || ""} ${e?.attempt || ""} ${e?.why || ""} ${e?.evidence || ""}`;
const isoOf = (now) => new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString();
const ymdOf = (now) => isoOf(now).slice(0, 10);

export const isSignalKind = (kind) => SIGNAL_KINDS.includes(String(kind || ""));

// ── 特征 / 相似度（纯函数，去重与"同一命令"判定共用一套）─────────────

function wordsOf(s) {
  const text = String(s || "").toLowerCase();
  const out = new Set();
  for (const m of text.matchAll(/[a-z0-9_][a-z0-9_.-]{1,}/g)) out.add(m[0]);
  const cjk = text.replace(/[^\u4e00-\u9fa5]+/g, " ");
  for (const chunk of cjk.split(/\s+/)) {
    if (chunk.length <= 2) { if (chunk.length === 2) out.add(chunk); continue; }
    for (let i = 0; i + 1 < chunk.length; i += 1) out.add(chunk.slice(i, i + 2));
  }
  return out;
}

function jaccard(A, B) {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const normFiles = (e) => (Array.isArray(e?.files) ? e.files : [e?.files])
  .map((f) => String(f || "").replace(/\\/g, "/").toLowerCase().trim()).filter(Boolean);

const normArea = (a) => String(a || "").replace(/[（(].*?[）)]/g, "").replace(/\s+/g, "").slice(0, 40).toLowerCase();
const normAttempt = (a) => String(a || "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

/** 失败签名：给人看、给测试钉的稳定指纹（不含时间/id）。 */
export function failureSignature(entry = {}) {
  return [normArea(entry.area), normAttempt(entry.attempt), clean(entry.why, 80).toLowerCase()].join(" | ");
}

/**
 * 两条失败的相似度 0..1：文本二元组（主）+ 同 attempt + 同 area + 文件重叠。
 * 用于去重（≥DEDUPE_THRESHOLD 合并）与"是不是同一条命令又失败了一遍"。
 */
export function failureSimilarity(a = {}, b = {}) {
  const A = wordsOf(textOf(a));
  const B = wordsOf(textOf(b));
  const textSim = jaccard(A, B);
  const sameAttempt = !!clean(a.attempt) && normAttempt(a.attempt) === normAttempt(b.attempt) ? 1 : 0;
  const sameArea = !!normArea(a.area) && normArea(a.area) === normArea(b.area) ? 1 : 0;
  const fa = normFiles(a);
  const fb = normFiles(b);
  let fileSim = 0;
  if (fa.length && fb.length) {
    const hit = fa.filter((f) => fb.includes(f)).length;
    fileSim = hit ? hit / new Set([...fa, ...fb]).size : 0;
  }
  return round3(0.6 * textSim + 0.2 * sameAttempt + 0.1 * sameArea + 0.1 * fileSim);
}

/** 是不是同一条命令（数字归一后 attempt 相同，或互相包含）。 */
function sameCommand(a, b) {
  const x = normAttempt(a?.attempt);
  const y = normAttempt(b?.attempt);
  if (!x || !y) return normArea(a?.area) && normArea(a?.area) === normArea(b?.area);
  return x === y || x.includes(y) || y.includes(x);
}

const isEnvironmental = (entry, ctx = {}) =>
  ctx.environmental === true || entry?.environmental === true || ENV_RE.test(textOf(entry));

/** 同一命令因环境失败了几次（含本条）。priorFailures 由调用方从台账读，纯函数不碰盘。 */
export function envFailureCount(entry = {}, ctx = {}) {
  const explicit = finite(ctx.envFailures ?? entry.envFailures ?? entry.repeatCount);
  const prior = Array.isArray(ctx.priorFailures) ? ctx.priorFailures : [];
  const env = isEnvironmental(entry, ctx);
  const matched = prior.filter((p) => p && p !== entry && isEnvironmental(p, {}) && sameCommand(p, entry)).length;
  return Math.max(explicit === null ? 0 : explicit, matched + (env ? 1 : 0));
}

/** 重试后成功了没：真字段优先，ctx 其次。 */
function retryOutcome(entry = {}, ctx = {}) {
  const attempts = finite(ctx.retryAttempts ?? entry.retryAttempts ?? entry.retries);
  const ok = ctx.retrySucceeded === true || ctx.retrySuccess === true
    || entry.retrySucceeded === true || entry.retrySuccess === true
    || (ctx.retry && ctx.retry.succeeded === true)
    || (entry.retry && entry.retry.succeeded === true);
  return { ok, attempts };
}

// ── 技能 / 知识命中 ─────────────────────────────────────────────

const skillName = (s) => clean(typeof s === "string" ? s : (s?.name || s?.title || s?.id || s?.skill || ""), 80);

/** 在 ctx.skills 里找与这次失败对应的技能：显式 skillId 优先，其次技能名出现在失败文本里。 */
export function matchSkill(entry = {}, skills = []) {
  const list = Array.isArray(skills) ? skills.filter(Boolean) : [];
  const declared = clean(entry.skill || entry.skillId || entry.skillName || "");
  if (declared) {
    const hit = list.find((s) => [skillName(s), clean(s?.id, 80)].filter(Boolean).some((n) => n === declared || n.includes(declared) || declared.includes(n)));
    if (hit) return { skill: hit, matchedBy: `显式 skill=${declared}` };
  }
  const text = textOf(entry).toLowerCase();
  const hit = list.find((s) => {
    const n = skillName(s).toLowerCase();
    if (!n) return false;
    if (text.includes(n)) return true;
    const toks = n.split(/[\s/·、,，]+/).filter((t) => t.length >= 3);
    return toks.some((t) => text.includes(t));
  });
  return hit ? { skill: hit, matchedBy: `失败文本命中技能「${skillName(hit)}」` } : null;
}

/** 在 ctx.knowledge 里找对应知识条目（{title|text|id}）。 */
export function matchKnowledge(entry = {}, knowledge = []) {
  const list = Array.isArray(knowledge) ? knowledge.filter(Boolean) : [];
  if (!list.length) return null;
  const text = textOf(entry).toLowerCase();
  const hit = list.find((k) => {
    const n = clean(typeof k === "string" ? k : (k?.title || k?.topic || k?.id || k?.text), 120).toLowerCase();
    if (!n) return false;
    return text.includes(n) || n.split(/\s+/).filter((t) => t.length >= 3).some((t) => text.includes(t));
  });
  return hit ? { entry: hit, matchedBy: `失败文本命中知识「${clean(hit?.title || hit?.topic || hit?.id || hit, 40)}」` } : null;
}

// ── 归因主函数 ──────────────────────────────────────────────────

const verdict = (kind, confidence, reason, evidence = [], extra = {}) => ({
  kind,
  isSignal: isSignalKind(kind),
  reason,
  confidence: round3(Math.max(0, Math.min(1, confidence))),
  evidence: evidence.filter(Boolean).slice(0, 6),
  ...extra,
});

/**
 * 四类归因（纯函数）。
 * @param {object} entry 失败条目 {area, attempt, why, files, evidence, kind, retrySucceeded, environmental, skill, ...}
 * @param {object} ctx   真实证据 {priorFailures, skills, knowledge, retrySucceeded/retry, envFailures, environmental}
 * @returns {{kind:string, isSignal:boolean, reason:string, confidence:number, evidence:string[], needsReview?:boolean}}
 */
export function classifyFailure(entry = {}, ctx = {}) {
  const e = entry && typeof entry === "object" ? entry : { attempt: String(entry ?? "") };
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const text = textOf(e);

  // ① 台账里已显式判过"做不到"
  if (e.kind === "impossible" || /已判定做不到|停止重试/.test(`${e.attempt || ""} ${e.why || ""}`)) {
    return verdict("task_impossible", 0.95,
      "台账里已显式判定「做不到（停止重试）」，不是缺陷",
      ["entry.kind=impossible", clean(e.why, 80)]);
  }

  // ② 同一命令多次因环境失败 → 环境不允许，改代码没用
  const envs = envFailureCount(e, c);
  if (envs >= ENV_IMPOSSIBLE_THRESHOLD) {
    return verdict("task_impossible", 0.85,
      `同一命令因环境原因失败 ${envs} 次（≥${ENV_IMPOSSIBLE_THRESHOLD}）：换写法也过不了，先别算缺陷`,
      [`环境失败 ${envs} 次`, clean(e.why, 100)]);
  }

  // ③ 重试后成功 → 第一次是手段/工具没选对，任务本身可行
  const retry = retryOutcome(e, c);
  if (retry.ok) {
    return verdict("tool_insufficient", 0.9,
      `重试${retry.attempts ? ` ${retry.attempts} 次后` : "后"}成功：失败原因在手段/工具，不在任务本身`,
      ["retrySucceeded=true", clean(e.why, 100)]);
  }

  const envish = isEnvironmental(e, c);
  const toolish = TOOL_RE.test(text);
  const complianceHit = NONCOMPLIANT_RE.test(text);
  const gapHit = GAP_RE.test(text);
  const skills = Array.isArray(c.skills) ? c.skills : [];
  const knowledge = Array.isArray(c.knowledge) ? c.knowledge : [];
  const skill = matchSkill(e, skills);
  const knowledgeHit = matchKnowledge(e, knowledge);
  const skillLabel = skill ? skillName(skill.skill) || "技能" : "";

  // ④ 技能在手：缺知识 > 没照做 > 默认没照做（低置信，留给人复核）
  if (skill) {
    if (gapHit && (!complianceHit || /没写|未写|没有写|缺少|缺失|未覆盖|未记录|不知道|不会/.test(text))) {
      return verdict("skill_knowledge_gap", 0.8,
        `技能「${skillLabel}」没有覆盖这种情况：${clean(e.why, 80)}——补技能/知识条目能解`,
        [skill.matchedBy, "失败原因指向缺知识", clean(e.why, 100)]);
    }
    if (complianceHit) {
      return verdict("skill_noncompliant", 0.82,
        `技能「${skillLabel}」有，但这次没照着做：${clean(e.why, 80)}——可改进信号`,
        [skill.matchedBy, "失败原因指向违规/跳过步骤", clean(e.why, 100)]);
    }
    // 技能是对的，坏在环境/工具上：这条不是技能的错，别塞进改进队列
    if (envish || toolish) {
      return verdict("tool_insufficient", 0.68,
        `技能「${skillLabel}」执行时撞上${envish ? "环境" : "工具"}问题（环境失败 ${envs} 次）：先修工具/等环境，不归罪技能`,
        [skill.matchedBy, "失败原因指向环境/工具", clean(e.why, 100)]);
    }
    return verdict("skill_noncompliant", 0.6,
      `命中技能「${skillLabel}」却失败，且没有缺知识/环境/工具迹象：按「没照做」处理（低置信，建议人工复核）`,
      [skill.matchedBy, clean(e.why, 100)], { needsReview: true });
  }

  // ⑤ 没有命中技能，但失败原因明显是"没这条知识" → 知识缺口
  if (gapHit && !envish) {
    return verdict("skill_knowledge_gap", knowledgeHit ? 0.62 : 0.6,
      `失败原因是缺知识（${knowledgeHit ? `知识库有相近条目「${knowledgeHit.matchedBy}」但仍不够` : "技能/知识库都没有这一条"}）：${clean(e.why, 80)}`,
      [knowledgeHit?.matchedBy, "失败原因指向缺知识", clean(e.why, 100)]);
  }

  // ⑥ 环境/工具层面：换工具、装依赖、换接口能过（次数没到阈值）
  if (envish || toolish) {
    return verdict("tool_insufficient", envish ? 0.66 : 0.72,
      `${envish ? "环境" : "工具"}原因失败（环境失败 ${envs} 次，未达 ${ENV_IMPOSSIBLE_THRESHOLD}）：换工具/补依赖/换接口可解，不算任务本身不可能`,
      [`环境失败 ${envs} 次`, envish ? "命中环境错误特征" : "命中工具缺失特征", clean(e.why, 100)]);
  }

  // ⑦ 证据不足：既没有技能可对照，也没有环境/工具线索
  //    宁可先当"改不了"，也不让噪声灌满改进队列；低置信 + needsReview 便于人翻案。
  return verdict("task_impossible", 0.25,
    `证据不足：既没命中技能/知识，也没有环境或工具线索（${clean(e.why, 60) || "无失败原因"}）——先按不可改处理，低置信待复核`,
    ["无技能命中", "无环境/工具线索", clean(e.why, 100)], { needsReview: true });
}

// ── 相似失败去重（≥0.85 合并，参考 hermes --prune）─────────────────

/**
 * 纯函数去重：先出现的保留，后面的相似条目并进去（occurrences 累加，不丢次数）。
 * 台账落盘顺序是「新的在前」，所以合并方向 = 并进最新那条，保留最新归因。
 * @returns {{items:object[], merged:Array<{keepId:string, dropped:string[], similarity:number}>, mergedCount:number}}
 */
export function dedupeFailures(items = [], { threshold = DEDUPE_THRESHOLD } = {}) {
  const t = finite(threshold);
  const limit = t === null ? DEDUPE_THRESHOLD : t;
  const kept = [];
  const merged = [];
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== "object") continue;
    const item = { ...raw, occurrences: Math.max(1, finite(raw.occurrences) ?? 1) };
    const hit = kept.find((k) => failureSimilarity(k, item) >= limit);
    if (!hit) { kept.push(item); continue; }
    hit.occurrences += item.occurrences;
    const sim = failureSimilarity(hit, item);
    hit.lastAt = Math.max(Number(hit.at) || 0, Number(item.at) || 0, Number(hit.lastAt) || 0);
    hit.files = [...new Set([...(hit.files || []), ...(item.files || [])])].slice(0, 20);
    hit.mergedIds = [...new Set([...(hit.mergedIds || []), String(item.id || ""), ...(item.mergedIds || [])])].filter(Boolean);
    if (item.why && !String(hit.why || "").includes(String(item.why).slice(0, 40))) {
      hit.mergedReasons = [...new Set([...(hit.mergedReasons || []), clean(item.why, 120)])].slice(0, 3);
    }
    const group = merged.find((m) => m.keepId === hit.id);
    if (group) { group.dropped.push(String(item.id || "")); group.similarity = Math.max(group.similarity, sim); }
    else merged.push({ keepId: String(hit.id || ""), dropped: [String(item.id || "")], similarity: sim });
  }
  return { items: kept, merged, mergedCount: (Array.isArray(items) ? items.length : 0) - kept.length };
}

// ── 看板 / 报告 ───────────────────────────────────────────────

/** 四类分布 + 最近条目（纯函数：条目由调用方给）。旧条目没有 attribution 就现场归因一次。 */
export function attributionReport({ items = [], limit = 20, now = Date.now() } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter((x) => x && typeof x === "object");
  const distribution = Object.fromEntries(FAILURE_KINDS.map((k) => [k, 0]));
  const signalReasons = Object.fromEntries(SIGNAL_KINDS.map((k) => [k, 0]));
  const annotated = rows.map((e) => {
    const stored = e.attribution && FAILURE_KINDS.includes(e.attribution.kind) ? e.attribution : null;
    const attr = stored || classifyFailure(e, { priorFailures: rows });
    distribution[attr.kind] += 1;
    if (attr.isSignal) signalReasons[attr.kind] += 1;
    return { entry: e, attr, inferred: !stored };
  });
  const signal = annotated.filter((x) => x.attr.isSignal).length;
  const needsReview = annotated.filter((x) => x.attr.needsReview === true || Number(x.attr.confidence) < 0.5).length;
  const recent = annotated.slice(0, Math.max(1, limit)).map(({ entry, attr, inferred }) => ({
    id: entry.id || "", at: Number(entry.at) || 0, area: entry.area || "", attempt: entry.attempt || "",
    why: entry.why || "", files: entry.files || [], source: entry.source || "",
    kind: attr.kind, kindLabel: KIND_LABELS[attr.kind] || attr.kind,
    isSignal: attr.isSignal === true, reason: attr.reason || "", confidence: attr.confidence,
    needsReview: attr.needsReview === true || Number(attr.confidence) < 0.5, inferred,
  }));
  return {
    ok: true,
    generatedAt: isoOf(now),
    total: rows.length,
    distribution,
    signal,
    signalReasons,
    nonSignal: rows.length - signal,
    needsReview,
    recent,
  };
}

// ── 改进队列（只有 isSignal 的进来；≥0.85 相似合并，并接 lesson-promotion）──

export function loadImprovementQueue(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(wsRoot || "."), IMPROVEMENT_QUEUE_REL), "utf8"));
    if (raw && Array.isArray(raw.items)) return { v: 1, items: raw.items, updatedAt: raw.updatedAt || 0 };
  } catch { /* 没有就当空队列 */ }
  return { v: 1, items: [], updatedAt: 0 };
}

function writeImprovementQueue(wsRoot, data) {
  const file = path.join(String(wsRoot || "."), IMPROVEMENT_QUEUE_REL);
  atomicWriteJson(file, { ...data, v: 1, updatedAt: Date.now() });
  return file;
}

/** 队列条目 → 可喂给 lesson-promotion 的教训形状（{text, topic}）。 */
export function improvementLesson(item = {}) {
  const kind = KIND_LABELS[item.kind] || item.kind || "失败";
  const area = clean(item.area, 24) || "未命名";
  const why = clean(item.why || item.attempt, 100);
  return { text: clean(`[${kind}] ${area}：${why}`, 120), topic: area };
}

/**
 * 把一条 isSignal 的失败放进改进队列：
 *   · 队列里已有 ≥0.85 相似的 open 条目 → 合并（occurrences+1），不新增；
 *   · 同时把一条教训候选写进 lesson-promotion 的教训账（记忆/做梦/教训账.json），
 *     复盘时 findRecurringLessons 跨日复现就会自动提晋升——这就是"接 lesson-promotion"的那一步。
 * @returns {{ok:boolean, created:boolean, item:object, file?:string, lesson?:object, error?:string}}
 */
export function enqueueImprovement({ wsRoot, entry = {}, attribution = {}, now = Date.now(), threshold = DEDUPE_THRESHOLD, lessonLedger = true } = {}) {
  const root = String(wsRoot || ".");
  const attr = attribution && typeof attribution === "object" ? attribution : {};
  if (attr.isSignal !== true) return { ok: false, created: false, item: null, error: "不是可改进信号（isSignal:false），不进改进队列" };
  const at = Number(entry.at) || Number(now) || Date.now();
  const data = loadImprovementQueue(root);
  const base = {
    kind: attr.kind, isSignal: true, confidence: attr.confidence,
    area: clean(entry.area, 80), attempt: clean(entry.attempt, 200), why: clean(entry.why, 200),
    files: (entry.files || []).slice(0, 20), source: entry.source || "manual",
    reason: clean(attr.reason, 300), evidence: Array.isArray(attr.evidence) ? attr.evidence.slice(0, 6) : [],
    failureId: entry.id || "", lastAt: at, status: "open",
  };
  const prior = data.items.find((it) => it.status === "open" && failureSimilarity({ ...it, at: it.lastAt ?? it.at }, { ...base, at }) >= threshold);
  if (prior) {
    prior.occurrences = Math.max(1, finite(prior.occurrences) ?? 1) + 1;
    prior.lastAt = Math.max(Number(prior.lastAt) || 0, at);
    prior.failureIds = [...new Set([...(prior.failureIds || []), base.failureId].filter(Boolean))].slice(0, 20);
    const file = writeImprovementQueue(root, data);
    return { ok: true, created: false, item: prior, file, lesson: { appended: false, reason: "合并进已有队列条目" } };
  }
  const item = {
    id: `q-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at, occurrences: 1, ...base, failureIds: base.failureId ? [base.failureId] : [],
  };
  data.items = [item, ...data.items].slice(0, MAX_QUEUE);
  const file = writeImprovementQueue(root, data);
  let lesson = { appended: false, reason: "未接教训账" };
  if (lessonLedger) {
    try { lesson = appendLessonCandidate({ wsRoot: root, entry, attribution: attr, now: at }); }
    catch (e) { lesson = { appended: false, error: String(e?.message || e).slice(0, 160) }; }
  }
  return { ok: true, created: true, item, file, lesson };
}

/** 往 lesson-promotion 的教训账追加一条候选；相近的（SIMILAR_MIN）不重复写。 */
function appendLessonCandidate({ wsRoot, entry = {}, attribution = {}, now = Date.now() } = {}) {
  const file = path.join(String(wsRoot || "."), LESSON_LEDGER);
  let ledger = { lessons: [], promoted: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && Array.isArray(raw.lessons)) {
      ledger = { lessons: raw.lessons, promoted: Array.isArray(raw.promoted) ? raw.promoted : [] };
    }
  } catch { /* 没有账就当新账 */ }
  const seed = improvementLesson({ kind: attribution.kind, area: entry.area, why: entry.why || entry.attempt });
  const dup = [...ledger.lessons, ...ledger.promoted].some((l) => l && lessonSimilarity(seed, l) >= SIMILAR_MIN);
  if (dup) return { appended: false, reason: "教训账里已有相近条目（≥0.34）", text: seed.text };
  ledger.lessons.push({
    ...seed, ymd: ymdOf(now), at: isoOf(now),
    source: "failure-attribution", kind: attribution.kind, failureId: entry.id || "",
  });
  ledger.lessons = ledger.lessons.slice(-LESSON_CAP);
  atomicWriteJson(file, ledger);
  return { appended: true, text: seed.text, topic: seed.topic, file };
}

/** 读改进队列（默认只看 open）。 */
export function listImprovementQueue(wsRoot, { status = "open", limit = 20 } = {}) {
  const items = loadImprovementQueue(wsRoot).items || [];
  const filtered = status ? items.filter((it) => it.status === status) : items;
  return filtered.slice(0, Math.max(1, limit));
}
