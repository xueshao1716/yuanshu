// ===== degradation.mjs —— 退化自评 + 自救阶梯 + 全局暂停闸（2026-11-09）=====
//
// 病：元枢的故障信号各自为政——watchdog-drift 判审计行跑偏、failure-ledger 数失败、
// 微信熔断、限流、子体卡死——**没有"我这一轮整体多差"的统一判断**，更没有"差到什么
// 程度该做什么"的分级动作。run-observability 只有 busy/degraded 二值。
//
// 源设计：Linxinyu docs/reports/2026-04-07-degradation-monitor-design.md:32-56（5 维子分 +
// 每维证据来源 + 6 个低风险自救动作 + 三车道 primary/recovery/auxiliary）。**只借那张表，
// 不搬它的代码**——它的状态真相在自己的 mother runtime，这里长在元枢的工作区台账上。
//
// 三条纪律（和 proactive-policy 同款）：
//   ① 评分是纯函数：assessDegradation({signals, now}) 不读盘、不看系统时钟，任何判定都能在
//      测试里复现；读盘的活全在 collectSignals(wsRoot)。
//   ② 拿不到的维度标 evaluated:false（"unevaluated"），总分只按**已评估维度**归一——
//      宁可承认"这维我看不见"，也不拿 0 分冒充"很健康"。
//   ③ 动作分险：low 只做可逆、不碰用户东西的事；medium（text-only）和 high（global-pause）
//      只在 critical 出现，且 high 才允许写全局闸（高危暂停.json），且必须带理由。
//
// 2026-11-09 补：**动作会自己跑，但只跑 low**。applyLowRiskOnly 挂在 server 的 10 分钟循环上，
// 每轮最多执行一个动作、同一条动作 30 分钟内不重复；medium/high 一律只落
// `skipped:'requires-human'` 等人点。自动挂的闸署名 `degradation:auto`，健康 30 分钟后由
// releaseAutoPauses 放回；当前挂着哪些闸（谁挂的、什么时候挂的）由 activeActions() 暴露给
// GET /api/degradation 的 activeActions[]。
//
// 落位：
//   · 评分读的信号（全部是已有台账，不新造埋点）：
//       记忆/运行时/动作审计.jsonl   —— 工具失败率（delivery-gate 的同一批行）
//       记忆/运行时/交付门.json      —— GREEN 比例（genome-growth 判"判断力"用的同一份）
//       记忆/运行时/反模式命中.jsonl —— AP-002/009/... 幻觉类命中（unified-chat 收轮自动写）
//       记忆/运行时/每轮耗时.jsonl   —— usage.lastCtx（上下文占用）+ 慢轮/空回复
//       记忆/运行时/失败台账.json    —— 按 classifyFailure 分出 provider/timeout/model
//       记忆/运行时/子代理.json      —— 卡死（running 超 timeoutMs）/ 超时失败
//   · 闸的读者（谁真的会被"暂停"）：proactive-policy、outbound、notifier、media/api

import fs from "node:fs";
import path from "node:path";
import { classifyFailure } from "./run-observability.mjs";
import { headroomCheck } from "./context-headroom.mjs";
// 2026-11-09：定时任务静默失败要并进同一张健康看板（reasons）。单向依赖：
// scheduled-policy 不 import 本文件，所以不会成环。
import { readScheduledHealth } from "./scheduled-policy.mjs";

// ── 文件位置 ────────────────────────────────────────────────────────────
export const PAUSE_REL = path.join("记忆", "运行时", "高危暂停.json");
export const ACTION_LOG_REL = path.join("记忆", "运行时", "退化动作.jsonl");
const AUDIT_REL = path.join("记忆", "运行时", "动作审计.jsonl");
const DELIVERY_REL = path.join("记忆", "运行时", "交付门.json");
const HIT_REL = path.join("记忆", "运行时", "反模式命中.jsonl");
const TURN_REL = path.join("记忆", "运行时", "每轮耗时.jsonl");
const FAILURE_REL = path.join("记忆", "运行时", "失败台账.json");
const SUBAGENT_REL = path.join("记忆", "运行时", "子代理.json");

// ── 等级阈值（score 越高越差）────────────────────────────────────────────
export const THRESHOLDS = Object.freeze({ degraded: 0.45, critical: 0.72 });

// ── 每个维度的名字（顺序固定，方便表格化输出）──────────────────────────────
export const DIMENSIONS = Object.freeze([
  "competence", "hallucination", "contextPressure", "modelStability", "subagents",
]);

// ── 动作阶梯。risk 决定"谁能写全局闸"，level 决定"什么等级才出现"。──────
// 全部 reversible: true —— 这一版没有任何不可逆自救（不改代码、不删记忆）。
export const ACTIONS = Object.freeze({
  "compress-session": Object.freeze({ risk: "low", reversible: true, level: "degraded", label: "压缩会话" }),
  "switch-model": Object.freeze({ risk: "low", reversible: true, level: "degraded", label: "切备用模型" }),
  "pause-proactive": Object.freeze({ risk: "low", reversible: true, level: "degraded", label: "暂停主动打扰", scope: "proactive" }),
  "freeze-subagents": Object.freeze({ risk: "low", reversible: true, level: "degraded", label: "冻结子体" }),
  "text-only": Object.freeze({ risk: "medium", reversible: true, level: "critical", label: "只文字、停媒体", scope: "media" }),
  "global-pause": Object.freeze({ risk: "high", reversible: true, level: "critical", label: "全局暂停外发" }),
});

/** 只有这些动作允许把全局闸打开（on:true）。 */
export const HIGH_RISK_ACTIONS = Object.freeze(["global-pause"]);
/** 分项停用只认自己的动作：主动推送 ← pause-proactive；媒体 ← text-only。 */
export const SCOPE_ACTIONS = Object.freeze({ proactive: "pause-proactive", media: "text-only" });

// ── 自动执行边界（2026-11-09，用户批准）────────────────────────────────
// 只自动跑 risk:'low'；text-only（medium）与 global-pause（high）**永远要人点**。
// 这两条不是"配置"，是硬约束：自动路径里直接跳过并落 skipped:'requires-human'。
export const HUMAN_ONLY_ACTIONS = Object.freeze(["text-only", "global-pause"]);
export const AUTO_RISK = "low";
/** 同一条自动动作 30 分钟内不重复执行（防抖），与 ACTION_COOLDOWN_MS 同值但语义不同。 */
export const AUTO_ACTION_COOLDOWN_MS = 30 * 60 * 1000;
/** 自动写闸用的署名：以 degradation 开头 → 健康 30 分钟后能被 releaseAutoPauses 放回。 */
export const GATE_BY_AUTO = "degradation:auto";
/** 动作 → "它是哪一维的证据"。用于 trigger.subscore（审计时能说清是凭哪一维动手的）。 */
export const ACTION_DIM = Object.freeze({
  "compress-session": "contextPressure",
  "switch-model": "modelStability",
  "pause-proactive": "hallucination",
  "freeze-subagents": "subagents",
  "text-only": "modelStability",
  "global-pause": "hallucination",
});

// ── 校准常数（都 export，测试直接钉住，别在实现里藏魔法数字）──────────────
export const COMPETENCE = Object.freeze({
  minToolSamples: 5,        // 少于 5 次工具调用不判（样本不足）
  toolFull: 0.35,           // 工具失败率 35% = 满分恶化
  minDeliverySamples: 3,    // 少于 3 条交付门记录不判
  redFull: 0.5,             // 非 GREEN 比例 50% = 满分恶化
  toolWeight: 0.6,
  deliveryWeight: 0.4,
});
export const HALLUCINATION = Object.freeze({
  // 幻觉类反模式：编造事实 / 报数不复核 / 假完成 / 循环确认（AP-005 = 无证据断言，也在内）
  ids: Object.freeze(["AP-001", "AP-002", "AP-005", "AP-009", "AP-012"]),
  severityWeight: Object.freeze({ high: 1, medium: 0.6, low: 0.3 }),
  hitFull: 3,               // 加权命中 3 次 = 满分恶化
});
export const CONTEXT = Object.freeze({
  baseRatio: 0.5,           // 占 50% 以内不算压力
  spanRatio: 0.45,          // 50% → 95% 之间线性拉满
  tightFloor: 0.85,         // headroom 判"tight"（余量 < 8k）时至少 0.85
  defaultWindow: 200_000,   // 拿不到模型窗口时的估算基准（会在 evidence 里标 estimated）
});
export const MODEL = Object.freeze({
  weight: Object.freeze({ provider: 1, timeout: 0.8, model: 0.7, empty: 0.5, slow: 0.3 }),
  failFull: 4,              // 加权失败 4 次 = 满分恶化
  slowTurnMs: 60_000,       // 单轮 60s 算慢
  emptyOutputTokens: 24,    // 单轮 output ≤24 token 算空回复
  minTurns: 3,              // 少于 3 轮不判（空转的进程不代表模型不稳）
});
export const SUBAGENT = Object.freeze({
  defaultTimeoutMs: 15 * 60_000,  // 与 subagent-background.BACKGROUND_TIMEOUT_MS 同值
  weight: Object.freeze({ stalled: 1, timeout: 0.6 }),
  fullWeighted: 2,               // 加权 2（= 卡死 2 个 或 卡 1 + 超时 1.7）拉满
});

export const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;   // 看最近 6 小时
export const ACTION_COOLDOWN_MS = 30 * 60 * 1000;      // 同一状态 30 分钟内不重复追加动作
// 单维爆表的两道硬线：总分是"平均+最坏"的混合分，但某一维真的烂透了要能自己把等级拉上去，
// 否则"幻觉全中、其余看着还行"会被平均稀释成 healthy（这是最危险的误判方向）。
export const HARD_DIM = Object.freeze({ critical: 0.9, degraded: 0.75 });
// 总分混合权重：mean 说"整体多差"，worst 说"最烂那一维多差"
export const SCORE_WEIGHTS = Object.freeze({ mean: 0.6, worst: 0.4 });

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

// ============================ 一、五个维度的子分 ============================

/** 等级：纯 score 映射（不含其他条件，方便单测边界）。 */
export function levelOf(score) {
  const s = Number.isFinite(Number(score)) ? Number(score) : 0;
  if (s >= THRESHOLDS.critical) return "critical";
  if (s >= THRESHOLDS.degraded) return "degraded";
  return "healthy";
}

const dim = (score, evaluated, evidence = {}, note = "") => ({ score: clamp01(score), evaluated: !!evaluated, evidence, note });

/**
 * 胜任：近 N 轮工具失败率（动作审计）+ 交付门非 GREEN 比例。
 * 两个来源各算一个 0..1，缺一个就只按另一个算（权重在已用的来源上重新归一）。
 */
export function scoreCompetence(sig) {
  const g = sig?.competence;
  if (!g || typeof g !== "object") return dim(0, false, {}, "没有动作审计/交付门数据");
  const calls = Math.max(0, Number(g.toolCalls) || 0);
  const fails = Math.max(0, Number(g.toolFailures) || 0);
  const dTotal = Math.max(0, Number(g?.deliveries?.total) || 0);
  const dGreen = Math.min(dTotal, Math.max(0, Number(g?.deliveries?.green) || 0));
  const parts = [];
  const ev = { toolCalls: calls, toolFailures: fails, deliveries: { total: dTotal, green: dGreen } };
  if (calls >= COMPETENCE.minToolSamples) {
    const rate = fails / calls;
    ev.toolFailRate = Number(rate.toFixed(4));
    parts.push([clamp01(rate / COMPETENCE.toolFull), COMPETENCE.toolWeight]);
  }
  if (dTotal >= COMPETENCE.minDeliverySamples) {
    const red = 1 - dGreen / dTotal;
    ev.deliveryNonGreenRate = Number(red.toFixed(4));
    parts.push([clamp01(red / COMPETENCE.redFull), COMPETENCE.deliveryWeight]);
  }
  if (!parts.length) return dim(0, false, ev, `样本不足（工具 ${calls} 次 / 交付门 ${dTotal} 条）`);
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  const score = parts.reduce((s, [v, w]) => s + v * w, 0) / wsum;
  return dim(score, true, ev);
}

/**
 * 幻觉：反模式命中里"编造/不复核/假完成"这几类。severity 加权，命中越多越差。
 * hits = [{id, at, severity}]（severity 缺省按 high 算——台账里这几条本来就是 high）。
 */
export function scoreHallucination(sig) {
  const g = sig?.hallucination;
  if (!g || !Array.isArray(g.hits)) return dim(0, false, {}, "没有反模式命中记录");
  let weighted = 0;
  const byId = {};
  for (const h of g.hits) {
    const id = String(h?.id || "");
    if (!HALLUCINATION.ids.includes(id)) continue;
    const w = HALLUCINATION.severityWeight[String(h?.severity || "high")] ?? 1;
    weighted += w;
    byId[id] = (byId[id] || 0) + 1;
  }
  const ev = { hits: g.hits.length, weighted: Number(weighted.toFixed(2)), byId };
  const score = clamp01(weighted / HALLUCINATION.hitFull);
  // 文件在、这个窗口内一条幻觉命中都没有 → 真的健康（0 分），不是"看不见"
  return dim(score, true, ev);
}

/**
 * 上下文压力：优先用每轮耗时里的 usage.lastCtx / 模型窗口（真 headroom），
 * 没有窗口就按 defaultWindow 估（evidence.estimated = true），
 * 连 lastCtx 都没有就退回本轮累计 usage.input（更粗，也标 estimated）。
 */
export function scoreContextPressure(sig) {
  const g = sig?.context;
  if (!g || typeof g !== "object") return dim(0, false, {}, "没有每轮耗时数据");
  const used = Math.max(0, Number(g.usedTokens) || 0);
  if (!used) return dim(0, false, {}, "每轮耗时里没有上下文占用（usage.lastCtx/input）");
  const measured = Number(g.contextWindow) > 0;
  const win = measured ? Number(g.contextWindow) : CONTEXT.defaultWindow;
  const hc = headroomCheck({ contextWindow: win, usedTokens: used });
  const ratio = hc.ratio;
  let score = clamp01((ratio - CONTEXT.baseRatio) / CONTEXT.spanRatio);
  if (hc.tight) score = Math.max(score, CONTEXT.tightFloor);
  const ev = {
    usedTokens: used,
    contextWindow: win,
    ratio: Number(ratio.toFixed(4)),
    room: hc.room,
    tight: hc.tight,
    source: String(g.source || "lastCtx"),
    estimated: !measured || g.estimated === true,
  };
  return dim(score, true, ev, measured ? "" : `窗口取默认 ${Math.round(win / 1000)}k 估（未拿到模型声明的窗口）`);
}

/**
 * 模型稳定：401/429/超时/空回复/慢轮。
 * failures 来自失败台账（用 run-observability.classifyFailure 分类，不自己编正则）；
 * slow/empty 来自每轮耗时（真机实测有 totalMs / usage.output）。
 */
export function scoreModelStability(sig) {
  const g = sig?.model;
  if (!g || typeof g !== "object") return dim(0, false, {}, "没有失败台账/每轮耗时数据");
  const f = g.failures || null;
  const turns = g.turns || null;
  const turnTotal = Math.max(0, Number(turns?.total) || 0);
  const hasFailures = !!f;
  if (!hasFailures && turnTotal < MODEL.minTurns) return dim(0, false, {}, "样本不足（无失败记录且轮次太少）");
  const c = {
    provider: Math.max(0, Number(f?.provider) || 0),
    timeout: Math.max(0, Number(f?.timeout) || 0),
    model: Math.max(0, Number(f?.model) || 0),
    empty: Math.max(0, Number(turns?.empty) || 0),
    slow: Math.max(0, Number(turns?.slow) || 0),
  };
  const weighted = Object.entries(c).reduce((s, [k, n]) => s + n * (MODEL.weight[k] || 0), 0);
  const ev = { ...c, turns: turnTotal, weighted: Number(weighted.toFixed(2)) };
  return dim(clamp01(weighted / MODEL.failFull), true, ev);
}

/**
 * 子体健康：卡死（running/queued 超过自己的 timeoutMs）+ 超时失败。
 * 只看已登记的子代理；没有登记表 → 看不见（不是健康）。
 */
export function scoreSubagents(sig) {
  const g = sig?.subagents;
  if (!g || !Array.isArray(g.items)) return dim(0, false, {}, "没有子代理登记表（记忆/运行时/子代理.json）");
  const now = Number(g.now) || 0;
  let stalled = 0, timeouts = 0, live = 0;
  const ids = [];
  for (const it of g.items) {
    const status = String(it?.status || "");
    const startMs = toMs(it?.startedAt ?? it?.queuedAt ?? it?.createdAt);
    if (status === "running" || status === "queued") {
      live += 1;
      const tmo = Math.max(60_000, Number(it?.timeoutMs) || SUBAGENT.defaultTimeoutMs);
      if (now && startMs && now - startMs > tmo) { stalled += 1; ids.push(String(it?.id || "")); }
      continue;
    }
    if (status === "failed" && (String(it?.errorCode || "") === "timeout" || /timeout|超时|timed out/i.test(String(it?.error || "")))) {
      timeouts += 1;
      ids.push(String(it?.id || ""));
    }
  }
  const weighted = stalled * SUBAGENT.weight.stalled + timeouts * SUBAGENT.weight.timeout;
  const ev = { total: g.items.length, live, stalled, timeouts, weighted: Number(weighted.toFixed(2)), ids: ids.slice(0, 8) };
  return dim(clamp01(weighted / SUBAGENT.fullWeighted), true, ev);
}

const SCORERS = Object.freeze({
  competence: scoreCompetence,
  hallucination: scoreHallucination,
  contextPressure: scoreContextPressure,
  modelStability: scoreModelStability,
  subagents: scoreSubagents,
});

// ============================ 二、动作阶梯 ============================

/**
 * 每个动作的触发条件（只看子分，不看总分——总分是给人看的，动作按维度挑）。
 * 理由句尽量带数字：出问题时能一眼看出是"哪一维、多少"。
 */
const LADDER = Object.freeze([
  {
    action: "compress-session", when: (s) => s.contextPressure.score >= 0.55,
    reason: (s) => `上下文已占 ${pct(s.contextPressure.evidence.ratio)}${s.contextPressure.evidence.estimated ? "（窗口为估算）" : ""}，先压缩会话再继续`,
  },
  {
    action: "switch-model", when: (s) => s.modelStability.score >= 0.5,
    reason: (s) => `模型侧失败 ${s.modelStability.evidence.weighted} 分（provider ${s.modelStability.evidence.provider} / 超时 ${s.modelStability.evidence.timeout} / 空回复 ${s.modelStability.evidence.empty}），切到备用车道`,
  },
  {
    action: "pause-proactive", when: (s) => s.hallucination.score >= 0.4 || s.competence.score >= 0.7,
    reason: (s) => (s.hallucination.score >= 0.4
      ? `幻觉类反模式命中 ${s.hallucination.evidence.weighted} 分，先别主动打扰人`
      : `工具失败率 ${pct(s.competence.evidence.toolFailRate)}，先别主动打扰人`),
  },
  {
    action: "freeze-subagents", when: (s) => s.subagents.score >= 0.5,
    reason: (s) => `子体卡死 ${s.subagents.evidence.stalled} 个 / 超时 ${s.subagents.evidence.timeouts} 个，先冻结不再派活`,
  },
  {
    action: "text-only", when: (s) => s.modelStability.score >= 0.75 || s.contextPressure.score >= 0.9,
    reason: (s) => (s.modelStability.score >= 0.75
      ? "模型稳定性很差，停媒体生成（出图/出片最吃额度，也最容易假完成）"
      : "上下文几乎满了，停媒体生成免得整轮被截断"),
  },
  {
    action: "global-pause", when: (s) => s.hallucination.score >= 0.7 && (s.competence.score >= 0.6 || s.modelStability.score >= 0.6),
    reason: (s) => `幻觉 ${pct(s.hallucination.score)} 且胜任/稳定同时差，先全局暂停外发（只记不发），等人看一眼`,
  },
]);

const pct = (r) => (Number.isFinite(Number(r)) ? `${Math.round(Number(r) * 100)}%` : "—");

/**
 * 按子分挑动作。只有**已评估**的维度能作为触发条件（看不见的东西不能当理由），
 * 且动作的 level 必须 ≤ 当前等级（degraded 只出 low，critical 才出 medium/high）。
 */
export function pickActions(subscores, level) {
  const out = [];
  if (level === "healthy") return out;
  const rank = { degraded: 1, critical: 2 }[level] || 0;
  // 只有**已评估**的维度能当触发条件：看不见的东西不许当理由（未评估一律按 0 参与判断）
  const s = {};
  for (const d of DIMENSIONS) {
    const sd = subscores?.[d];
    s[d] = sd?.evaluated ? sd : { score: 0, evaluated: false, evidence: {} };
  }
  for (const rule of LADDER) {
    const def = ACTIONS[rule.action];
    if (!def) continue;
    if (({ degraded: 1, critical: 2 }[def.level] || 0) > rank) continue;   // 等级没到，不上
    try {
      if (!rule.when(s)) continue;
    } catch { continue; }                                                  // 条件依赖缺字段 → 当不触发
    out.push({ action: rule.action, reason: rule.reason(s), risk: def.risk, reversible: def.reversible !== false, label: def.label });
  }
  return out;
}

// ============================ 三、总评 ============================

/**
 * 退化评估（纯函数）。
 *
 * 总分算式（测试里就是这么断言的）：
 *   mean  = Σ_{i ∈ 已评估维度} subscores[i].score / |已评估维度|   ← 这就是"按已评估归一"
 *   worst = max_{i ∈ 已评估维度} subscores[i].score
 *   score = 0.6 × mean + 0.4 × worst
 *
 * 为什么不是纯平均：五维里有一维烂透（比如幻觉全中）而其余正常时，纯平均会被稀释成
 * healthy——那正是最该报警的时候。worst 项把"最烂那一维"抬进总分，mean 项保留"整体多差"。
 *
 * 等级还要过两道单维硬线（HARD_DIM）：最坏一维 ≥0.9 直接 critical，≥0.75 至少 degraded。
 *
 * @param {{signals?:object, now?:number}} p
 * @returns {{score:number, meanScore:number, worstScore:number, level:string, levelFrom:string,
 *            subscores:object, evaluated:string[], unevaluated:string[],
 *            reasons:string[], actions:Array, at:number, v:number}}
 */
export function assessDegradation({ signals = {}, now = Date.now() } = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const subscores = {};
  for (const name of DIMENSIONS) subscores[name] = SCORERS[name](signals);

  const evaluated = DIMENSIONS.filter((d) => subscores[d].evaluated);
  const unevaluated = DIMENSIONS.filter((d) => !subscores[d].evaluated);
  const meanScore = evaluated.length
    ? clamp01(evaluated.reduce((s, d) => s + subscores[d].score, 0) / evaluated.length)
    : 0;
  const worstScore = evaluated.length ? Math.max(...evaluated.map((d) => subscores[d].score)) : 0;
  const score = clamp01(SCORE_WEIGHTS.mean * meanScore + SCORE_WEIGHTS.worst * worstScore);

  // 等级 = 混合分给的等级，再被单维硬线抬一档（只抬不降）
  let level = evaluated.length ? levelOf(score) : "healthy";
  let levelFrom = "score";
  if (evaluated.length && worstScore >= HARD_DIM.critical) { level = "critical"; levelFrom = "worst-dim"; }
  else if (evaluated.length && worstScore >= HARD_DIM.degraded && level === "healthy") { level = "degraded"; levelFrom = "worst-dim"; }

  const reasons = [];
  for (const d of DIMENSIONS) {
    const sd = subscores[d];
    if (!sd.evaluated) { reasons.push(`${d}：未评估（${sd.note || "没有数据"}）`); continue; }
    reasons.push(`${d}：${pct(sd.score)}${sd.note ? `（${sd.note}）` : ""}`);
  }
  reasons.unshift(`总分 ${score.toFixed(3)}（均值 ${meanScore.toFixed(3)} × ${SCORE_WEIGHTS.mean} + 最差 ${worstScore.toFixed(3)} × ${SCORE_WEIGHTS.worst}；`
    + `${evaluated.length}/${DIMENSIONS.length} 维已评估）→ ${level}${levelFrom === "worst-dim" ? "（单维硬线抬升）" : ""}`);

  const actions = pickActions(subscores, level);
  if (level !== "healthy" && !actions.length) reasons.push("等级已退化但没有任何动作条件命中（缺证据，不硬凑动作）");

  return {
    v: 1, at, score: Number(score.toFixed(4)), meanScore: Number(meanScore.toFixed(4)), worstScore: Number(worstScore.toFixed(4)),
    level, levelFrom,
    subscores, evaluated, unevaluated,
    reasons, actions,
    source: { windowMs: Number(signals?.windowMs) || DEFAULT_WINDOW_MS, at: Number(signals?.at) || at },
  };
}

// ============================ 四、读盘：把台账变成 signals ============================

const toMs = (v) => {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Date.parse(String(v));
  if (Number.isFinite(n)) return n;
  const num = Number(v);
  return Number.isFinite(num) ? num : 0;
};

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/** 只读文件尾巴（台账会长到几 MB，整读会拖慢每 10 秒一次的查询）。 */
export function readTailLines(file, { maxBytes = 256 * 1024, maxLines = 4000 } = {}) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    // 从文件中间切进去的第一行通常是半截，丢掉
    if (start > 0 && lines.length) lines.shift();
    return lines.slice(-maxLines).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * 读工作区台账，产出 assessDegradation 要吃的 signals。
 * **缺哪个文件，对应维度就是 null → 那一维 unevaluated**（不拿 0 冒充健康）。
 *
 * @param {string} wsRoot
 * @param {{now?:number, windowMs?:number, contextWindow?:number}} opts
 *        contextWindow：当前文本模型声明的窗口（调用方从模型目录拿，如 models.json 的
 *        contextWindow 字段）。不给就按 CONTEXT.defaultWindow 估，并在 evidence 里标 estimated。
 */
export function collectSignals(wsRoot, { now = Date.now(), windowMs = DEFAULT_WINDOW_MS, contextWindow = 0 } = {}) {
  const root = String(wsRoot || ".");
  const since = now - windowMs;
  const inWindow = (ms) => ms >= since && ms <= now + 60_000;
  const signals = { at: now, windowMs, competence: null, hallucination: null, context: null, model: null, subagents: null };

  // ① 胜任：动作审计（after 行）+ 交付门
  {
    const rows = readTailLines(path.join(root, AUDIT_REL))
      .map((r) => ({ ...r, atMs: toMs(r?.at) }))
      .filter((r) => r.atMs && inWindow(r.atMs));
    const after = rows.filter((r) => String(r?.phase || "") === "after");
    if (after.length) {
      const group = { toolCalls: after.length, toolFailures: after.filter((r) => r.ok === false).length };
      const ledger = readJsonSafe(path.join(root, DELIVERY_REL));
      const items = (Array.isArray(ledger?.items) ? ledger.items : []).filter((x) => {
        const ms = toMs(x?.at);
        return ms && inWindow(ms);
      });
      if (items.length) {
        group.deliveries = {
          total: items.length,
          green: items.filter((x) => String(x?.verdict || "").toUpperCase() === "GREEN").length,
        };
      }
      signals.competence = group;
    }
  }

  // ② 幻觉：反模式命中（unified-chat 收轮自动写；文件可能还不存在）
  {
    const file = path.join(root, HIT_REL);
    if (fs.existsSync(file)) {
      const hits = readTailLines(file)
        .map((h) => ({ id: String(h?.id || ""), at: toMs(h?.at ?? h?.recordedAt), severity: String(h?.severity || "high") }))
        .filter((h) => h.id && inWindow(h.at));
      signals.hallucination = { hits };
    }
  }

  // ③ 上下文：每轮耗时（usage.lastCtx 优先，usage.input 兜底）
  {
    const rows = readTailLines(path.join(root, TURN_REL))
      .map((r) => ({ r, ms: toMs(r?.at) }))
      .filter((x) => x.ms && inWindow(x.ms));
    if (rows.length) {
      const last = rows[rows.length - 1].r;
      const lastCtx = Math.max(0, Number(last?.usage?.lastCtx) || 0);
      const input = Math.max(0, Number(last?.usage?.input) || 0);
      const used = lastCtx || input;
      if (used) {
        const win = Math.max(0, Number(contextWindow) || 0);
        signals.context = {
          usedTokens: used,
          contextWindow: win,                  // 0 = 调用方没给，scoreContextPressure 会按默认窗口估并标 estimated
          source: lastCtx ? "lastCtx" : "input",
          estimated: !lastCtx,
          maxLastCtx: rows.reduce((m, x) => Math.max(m, Number(x.r?.usage?.lastCtx) || 0), 0),
        };
      }
      // 顺带把慢轮/空回复喂给模型稳定
      const slow = rows.filter((x) => (Number(x.r?.totalMs) || 0) >= MODEL.slowTurnMs).length;
      const empty = rows.filter((x) => (Number(x.r?.usage?.output) || 0) <= MODEL.emptyOutputTokens && (Number(x.r?.totalMs) || 0) > 1000).length;
      signals.model = { ...(signals.model || {}), turns: { total: rows.length, slow, empty } };
    }
  }

  // ④ 模型稳定：失败台账按 classifyFailure 分类（provider / timeout / model）
  {
    const ledger = readJsonSafe(path.join(root, FAILURE_REL));
    const items = (Array.isArray(ledger?.items) ? ledger.items : []).filter((x) => {
      const ms = toMs(x?.at);
      return ms && inWindow(ms);
    });
    if (items.length) {
      const failures = { provider: 0, timeout: 0, model: 0, other: 0 };
      for (const e of items) {
        const cat = classifyFailure(`${e?.why || ""} ${e?.attempt || ""}`, "failed");
        if (cat === "provider" || cat === "timeout" || cat === "model") failures[cat] += 1;
        else failures.other += 1;
      }
      signals.model = { ...(signals.model || {}), failures };
    }
  }

  // ⑤ 子体：登记表（running 超时=卡死；failed+timeout=超时）
  {
    const ledger = readJsonSafe(path.join(root, SUBAGENT_REL));
    const items = Array.isArray(ledger?.items) ? ledger.items : null;
    if (items) signals.subagents = { items, now };
  }

  return signals;
}

/** 一步到位：读盘 + 评估（查询接口/定时判断用）。 */
export function assessWorkspace(wsRoot, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const signals = collectSignals(wsRoot, { ...opts, now });
  const out = assessDegradation({ signals, now });
  out.workspace = String(wsRoot || "");
  out.signalsAt = signals.at;
  // 2026-11-09：定时任务静默失败并进同一张看板——「任务连续 3 次没产出」也是退化的一种，
  // 不该只躺在另一个 jsonl 里等人翻。这里只并进 reasons（不新增维度、不改总分算式），
  // 明细另挂 out.scheduled，GET /api/degradation 会原样带出去。
  try {
    const scheduled = readScheduledHealth(String(wsRoot || "."), { now });
    out.scheduled = {
      at: scheduled.at, windowMs: scheduled.windowMs,
      jobs: scheduled.jobs.length, silent: scheduled.silent,
      alerts: scheduled.alerts.slice(0, 10),
    };
    if (scheduled.reasons.length) out.reasons.push(...scheduled.reasons);
  } catch {
    out.scheduled = null;
  }
  return out;
}

// ============================ 五、全局暂停闸 ============================

const EMPTY_GATE = Object.freeze({ on: false, scopes: Object.freeze({ proactive: false, media: false }) });

const pauseFile = (wsRoot) => path.join(String(wsRoot || "."), PAUSE_REL);

function normalizeGate(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const scopes = r.scopes && typeof r.scopes === "object" ? r.scopes : {};
  return {
    on: r.on === true,
    scopes: { proactive: scopes.proactive === true, media: scopes.media === true },
    reason: String(r.reason || ""),
    by: String(r.by || ""),
    at: Number(r.at) || 0,
    action: String(r.action || ""),
    history: Array.isArray(r.history) ? r.history.slice(-20) : [],
  };
}

/**
 * 读闸（只读）。文件不存在 = 没暂停。
 * @returns {{on:boolean, scopes:{proactive:boolean, media:boolean}, reason:string, by:string, at:number,
 *            action:string, history:Array}}
 */
export function readPauseGate(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(pauseFile(wsRoot), "utf8"));
    return normalizeGate(raw);
  } catch { return { ...EMPTY_GATE, scopes: { ...EMPTY_GATE.scopes }, reason: "", by: "", at: 0, action: "", history: [] }; }
}

/** 某个作用域现在是不是停着（on:true 时所有作用域都算停）。 */
export function isPaused(wsRoot, scope = "global") {
  const gate = readPauseGate(wsRoot);
  if (gate.on) return gate;
  if (scope === "global") return gate.on ? gate : null;
  return gate.scopes[scope] === true ? gate : null;
}

/**
 * 写闸。
 *
 *   · 全局 on:true —— **只有 high 风险动作（global-pause）能写**，且必须带理由；
 *   · 分项 scope:'proactive' / 'media' —— 只认自己的动作（pause-proactive / text-only）；
 *   · on:false —— 解除（人和系统都能解，这是安全方向），记 who/why 进 history。
 *
 * @param {string} wsRoot
 * @param {{on:boolean, reason?:string, by?:string, action?:string, scope?:'global'|'proactive'|'media', at?:number}} p
 *        at：写入时刻（默认现在）。测试要复现"挂够 30 分钟"时注入，不许在实现里读系统时钟当参数。
 * @returns {{ok:boolean, gate?:object, error?:string}}
 */
export function setPauseGate(wsRoot, { on, reason = "", by = "", action = "", scope = "global", at = Date.now() } = {}) {
  const root = String(wsRoot || "");
  if (!root) return { ok: false, error: "没有工作区根，不知道闸写在哪" };
  const cur = readPauseGate(root);
  const why = String(reason || "").trim();
  const who = String(by || "").trim() || "unknown";
  const act = String(action || "").trim();
  const sc = ["global", "proactive", "media"].includes(scope) ? scope : "global";

  if (on === true) {
    if (!why) return { ok: false, error: "写闸必须带理由（reason）" };
    if (sc === "global") {
      if (!HIGH_RISK_ACTIONS.includes(act)) {
        return { ok: false, error: `只有 high 风险动作（${HIGH_RISK_ACTIONS.join("/")}）能写全局闸，收到「${act || "(空)"}」` };
      }
      if ((ACTIONS[act]?.risk) !== "high") return { ok: false, error: `动作 ${act} 不是 high 风险` };
    } else {
      const allowed = SCOPE_ACTIONS[sc];
      if (act !== allowed) return { ok: false, error: `scope=${sc} 只接受动作「${allowed}」，收到「${act || "(空)"}」` };
    }
  }

  const next = normalizeGate(cur);
  if (on === true && sc === "global") {
    next.on = true;
    next.scopes = { proactive: true, media: true };   // 全局停 = 分项也全停
  } else if (on === true) {
    next.scopes = { ...next.scopes, [sc]: true };
  } else if (sc === "global") {
    next.on = false;
    next.scopes = { proactive: false, media: false };
  } else {
    next.scopes = { ...next.scopes, [sc]: false };
  }
  next.reason = why || (on ? cur.reason : `解除：${why || "未说明"}`);
  next.by = who;
  next.at = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  next.action = act || (on ? "" : next.action);
  next.history = [...(next.history || []), { at: next.at, on: on === true, scope: sc, action: act, reason: next.reason, by: who }].slice(-20);

  try {
    const file = pauseFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    return { ok: false, error: `闸写不进去：${String(e?.message || e)}` };
  }
  return { ok: true, gate: normalizeGate(next) };
}

// ============================ 六、执行 + 记录（幂等）============================

/** 同一状态的动作键：等级 + 动作集合 + 子分（按 0.05 量化）。 */
export function actionKey(assessment) {
  const names = (assessment?.actions || []).map((a) => a.action).sort().join(",");
  const dims = DIMENSIONS.map((d) => {
    const s = assessment?.subscores?.[d];
    return s?.evaluated ? Math.round((Number(s.score) || 0) * 20) / 20 : "x";
  }).join("|");
  return `${assessment?.level || ""}#${names}#${dims}`;
}

/** 读动作记录（最近的在前）。 */
export function readActionLog(wsRoot, { limit = 20 } = {}) {
  const rows = readTailLines(path.join(String(wsRoot || "."), ACTION_LOG_REL), { maxBytes: 128 * 1024, maxLines: 500 });
  return rows.slice(-Math.max(1, limit)).reverse();
}

/**
 * 执行阶梯 + 落账（幂等）。
 *
 * 幂等有两层：
 *   ① 同一 actionKey 在 ACTION_COOLDOWN_MS 内不重复落账（重启/重复扫描不会刷屏）；
 *   ② 闸本身是状态，不是事件：同样的 on:true 再写一次结果一样（且 scope 相同就不写 history）。
 *
 * 只做**低风险副作用**：写闸（pause-proactive / text-only / global-pause）或只落一条"建议"
 * （compress-session / switch-model / freeze-subagents —— 真正的压缩、切换、冻结在调用方，
 * 这里不越权替别人动模型和子体）。
 *
 * 还有一条**只对分项闸生效的自动解除**（见 releaseAutoPauses）：
 * 连续 healthy 且闸是退化自评自己写的、已挂够 AUTO_RELEASE_HOLD_MS → 把 proactive/media 分项
 * 放回来。全局闸（慎）绝不自动解除：那要人看一眼。
 */
export function applyActions({ wsRoot, assessment, now = Date.now(), by = "degradation", cooldownMs = ACTION_COOLDOWN_MS } = {}) {
  const root = String(wsRoot || "");
  if (!root || !assessment) return { ok: false, error: "缺 wsRoot 或 assessment" };
  const key = actionKey(assessment);
  const log = readActionLog(root, { limit: 5 });
  const last = log[0];
  if (last && last.key === key && Number(now) - Number(last.at || 0) < cooldownMs) {
    return { ok: true, recorded: false, duplicate: true, key, skipped: (assessment.actions || []).map((a) => a.action) };
  }

  const applied = [];
  for (const a of assessment.actions || []) {
    const def = ACTIONS[a.action];
    if (!def) continue;
    const row = { action: a.action, risk: a.risk, reversible: a.reversible !== false, reason: a.reason };
    if (def.scope) {
      const r = setPauseGate(root, { on: true, reason: a.reason, by, action: a.action, scope: def.scope, at: now });
      row.effect = r.ok ? "paused" : "failed";
      if (!r.ok) row.error = r.error;
    } else if (a.action === "global-pause") {
      const r = setPauseGate(root, { on: true, reason: a.reason, by, action: a.action, scope: "global", at: now });
      row.effect = r.ok ? "paused" : "failed";
      if (!r.ok) row.error = r.error;
    } else {
      row.effect = "suggested";   // 压缩/切模型/冻结：只给建议，不替调用方动手
    }
    applied.push(row);
  }
  // 健康了就把"自己挂上的"分项闸放回来（全局闸不动）
  if (assessment.level === "healthy") applied.push(...releaseAutoPauses({ wsRoot: root, now, by }));

  const entry = {
    at: Number(now) || Date.now(), by: String(by || "degradation"), key,
    level: assessment.level, score: assessment.score,
    evaluated: assessment.evaluated, actions: applied,
  };
  try {
    const file = path.join(root, ACTION_LOG_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (e) {
    return { ok: false, error: `动作记录写不进去：${String(e?.message || e)}`, applied };
  }
  return { ok: true, recorded: true, key, applied };
}

/** 自动解除的最短悬挂时间：太短会在 healthy/degraded 之间来回抖。 */
export const AUTO_RELEASE_HOLD_MS = 30 * 60 * 1000;
const SELF_WRITTEN_BY = "degradation";

/**
 * 健康后回收分项闸：只回收"退化自评自己挂的"（by 以 degradation 开头）且已挂够 30 分钟的。
 * 人的手（by:api/user）挂的一律不动——不能替人做决定。
 * 全局 on:true 永远不自动解除（那等于悄悄恢复外发，风险方向不对）。
 */
export function releaseAutoPauses({ wsRoot, now = Date.now(), by = SELF_WRITTEN_BY } = {}) {
  const root = String(wsRoot || "");
  const released = [];
  if (!root) return released;
  const gate = readPauseGate(root);
  if (gate.on) return released;                        // 全局停着：分项解了也没意义，等人
  const mine = String(gate.by || "").startsWith(SELF_WRITTEN_BY);
  if (!mine) return released;
  if (Number(now) - Number(gate.at || 0) < AUTO_RELEASE_HOLD_MS) return released;
  for (const scope of Object.keys(SCOPE_ACTIONS)) {
    if (gate.scopes[scope] !== true) continue;
    const r = setPauseGate(root, {
      on: false, scope, by, action: SCOPE_ACTIONS[scope], at: now,
      reason: `连续评估 healthy，自动解除 ${scope} 分项暂停`,
    });
    if (r.ok) released.push({ action: "release", scope, effect: "released", reversible: true, reason: `连续健康，自动解除 ${scope}` });
  }
  return released;
}


// ============================ 六点五、自动执行（只 low）============================

/**
 * 署名归类：auto（自动钩子）/ degradation（自评但经人触发）/ human（人手挂的）。
 * 看板要一眼看出"这个闸是谁挂的"。
 */
const byKind = (by) => {
  const s = String(by || "");
  if (s === "auto" || s.startsWith(GATE_BY_AUTO)) return "auto";
  if (s.startsWith("degradation")) return "degradation";
  if (!s) return "unknown";
  return "human";
};

/**
 * 当前真正挂着的闸（GET /api/degradation 的 activeActions）。
 *
 * 每条都带 `by`（auto / degradation / human）和 `since`（这条作用域**是什么时候**被挂上的，
 * 从 history 里取，不是闸文件最后一次写入的时间）。全局停时只列一条 global——
 * 因为三个作用域同时停，逐条列是重复。
 *
 * @param {string} wsRoot
 * @returns {Array<{scope:string, action:string, by:string, byRaw:string, since:number, reason:string, autoReleasable:boolean}>}
 */
export function activeActions(wsRoot) {
  const gate = readPauseGate(wsRoot);
  const hist = Array.isArray(gate.history) ? gate.history : [];
  const lastOn = (scope) => [...hist].reverse().find((h) => h && h.scope === scope && h.on === true) || null;
  const out = [];
  if (gate.on) {
    out.push({
      scope: "global", action: gate.action || "global-pause",
      by: byKind(gate.by), byRaw: String(gate.by || ""),
      since: Number(gate.at) || 0, reason: gate.reason || "",
      autoReleasable: false,
    });
    return out;
  }
  for (const scope of Object.keys(SCOPE_ACTIONS)) {
    if (gate.scopes?.[scope] !== true) continue;
    const h = lastOn(scope);
    const by = byKind(h?.by || gate.by);
    out.push({
      scope,
      action: String(h?.action || SCOPE_ACTIONS[scope]),
      by, byRaw: String(h?.by || gate.by || ""),
      since: Number(h?.at) || Number(gate.at) || 0,
      reason: String(h?.reason || gate.reason || ""),
      autoReleasable: by === "auto" || by === "degradation",
    });
  }
  return out;
}

const subscoreMap = (assessment) => {
  const out = {};
  for (const d of DIMENSIONS) {
    const s = assessment?.subscores?.[d];
    out[d] = s?.evaluated ? Number((Number(s.score) || 0).toFixed(4)) : null;
  }
  return out;
};
const scoreOf = (assessment, dim) => {
  const s = assessment?.subscores?.[dim];
  return s?.evaluated ? Number(s.score) || 0 : 0;
};
/** 这个动作是凭哪一维动手的（写进 trigger.subscore，事后能对账）。 */
const dimOf = (action, assessment) =>
  action === "pause-proactive"
    ? (scoreOf(assessment, "hallucination") >= 0.4 ? "hallucination" : "competence")
    : (ACTION_DIM[action] || "competence");

function appendAutoLog(root, entry) {
  try {
    const file = path.join(root, ACTION_LOG_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ by: "auto", ...entry })}\n`, "utf8");
    return true;
  } catch { return false; }
}

/**
 * 只自动执行 **low 风险动作**（2026-11-09 用户批准的边界）。
 *
 * 硬约束（不是配置）：
 *   · `text-only`（medium）与 `global-pause`（high）**永远不执行**，只记 `skipped:'requires-human'`；
 *   · 不写全局闸（唯一会写全局闸的 global-pause 根本进不了候选）；
 *   · 每次调用最多执行 `limit`（默认 1）个动作——挂在 10 分钟循环上，一轮一个，防止一口气全挂；
 *   · 同一条动作 30 分钟内不重复执行（读盘上的 `by:'auto'` 记录，重启也不重放）。
 *
 * 可逆与可见：
 *   · 自动挂的闸署名 `degradation:auto` → 健康后 30 分钟由 releaseAutoPauses 自动放回；
 *   · 每次真执行都往 记忆/运行时/退化动作.jsonl 追一条 `by:'auto'` + `trigger:{level,subscore}`；
 *   · 挂上的闸由 activeActions() 在 GET /api/degradation 的 activeActions[] 里可见。
 *
 * compress-session / switch-model / freeze-subagents 仍按仓库既有约定只落"建议"
 * （真压缩/切模型/冻结会改用户现场，不在这次授权里；见 ACTIONS 的注释）。
 *
 * @param {{wsRoot:string, assessment?:object|null, now?:number, contextWindow?:number,
 *          limit?:number, cooldownMs?:number}} p
 */
export function applyLowRiskOnly({ wsRoot, assessment = null, now = Date.now(), contextWindow = 0, limit = 1, cooldownMs = AUTO_ACTION_COOLDOWN_MS } = {}) {
  const root = String(wsRoot || "");
  if (!root) return { ok: false, error: "没有工作区根，不知道动作记在哪" };
  const at = Number(now) || Date.now();
  const a = assessment || assessWorkspace(root, { now: at, contextWindow });
  const trigger = { level: String(a?.level || ""), score: Number(a?.score) || 0, subscore: subscoreMap(a) };
  const key = actionKey(a);

  // ① 健康：只做"放回"（保留既有 30 分钟 + 只放自己挂的那条规则），绝不执行任何动作
  if (a.level === "healthy") {
    const released = releaseAutoPauses({ wsRoot: root, now: at });
    const recorded = released.length
      ? appendAutoLog(root, { at, key, trigger, level: "healthy", score: a.score, executed: [], pendingHuman: [], skipped: [], released, pendingKey: "" })
      : false;
    return { ok: true, at, level: "healthy", score: a.score, trigger, key, executed: [], pendingHuman: [], skipped: [], released, recorded, limit: 0 };
  }

  // ② 分拣：medium/high 一律"待人工确认"，一个字都不执行
  const candidates = [];
  const pendingHuman = [];
  for (const act of a.actions || []) {
    const def = ACTIONS[act.action];
    const risk = String(def?.risk || act.risk || "unknown");
    if (HUMAN_ONLY_ACTIONS.includes(act.action) || risk !== AUTO_RISK) {
      pendingHuman.push({
        action: act.action, risk, label: def?.label || act.action,
        dim: ACTION_DIM[act.action] || "", reason: act.reason || "", skipped: "requires-human",
      });
      continue;
    }
    candidates.push({
      action: act.action, risk: AUTO_RISK, reversible: def?.reversible !== false,
      label: def?.label || act.action, reason: act.reason || "", scope: def?.scope || "",
    });
  }

  // ③ 全局闸（可能人挂的）优先于一切自动化：停着就一个动作都不动，只说明为什么
  const gateNow = readPauseGate(root);
  if (gateNow.on) {
    return {
      ok: true, at, level: a.level, score: a.score, trigger, key,
      executed: [], pendingHuman,
      skipped: candidates.map((c) => ({ action: c.action, reason: "全局闸已挂上（人工优先，自动路径不动）", skipped: "global-gate" })),
      released: [], recorded: false, limit: 0, paused: true,
    };
  }

  // ④ 同一条动作 30 分钟内不重复；已经停着的作用域不再改写（不能覆盖人的署名）
  const lastAuto = new Map();
  for (const row of readActionLog(root, { limit: 500 })) {
    if (String(row?.by || "") !== "auto") continue;
    const t = Number(row.at) || 0;
    for (const x of row.executed || []) {
      const id = String(x?.action || "");
      if (id) lastAuto.set(id, Math.max(lastAuto.get(id) || 0, t));
    }
  }
  const eligible = [];
  const skipped = [];
  for (const c of candidates) {
    // 已经停着就别再写一遍：分项停可能也是人挂的。再写一次会把 by/reason/at 改成"自动"，
    // 看板就分不清是谁的主意了。
    if (c.scope && gateNow.scopes?.[c.scope] === true) {
      skipped.push({ action: c.action, reason: `${c.scope} 分项已暂停（不覆盖现有署名）`, skipped: "already-paused" });
      continue;
    }
    const last = lastAuto.get(c.action) || 0;
    if (last && at - last < cooldownMs) {
      skipped.push({ action: c.action, reason: "cooldown", lastAt: last, remainMs: cooldownMs - (at - last), skipped: "cooldown" });
      continue;
    }
    eligible.push(c);
  }

  // ④ 每次最多执行一个（limit 默认 1）
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  const executed = [];
  for (const c of eligible.slice(0, max)) {
    const dim = dimOf(c.action, a);
    const row = { action: c.action, risk: AUTO_RISK, reversible: c.reversible !== false, dim, subscore: subscoreMap(a)[dim], reason: c.reason };
    // 双保险：即使上游分拣出了 bug，走到这里也不许写闸
    if (HUMAN_ONLY_ACTIONS.includes(c.action) || c.risk !== AUTO_RISK) {
      row.effect = "refused";
      row.error = `${c.action} 属于人工确认档，自动路径永不执行`;
      executed.push(row);
      continue;
    }
    if (c.scope) {
      const r = setPauseGate(root, { on: true, reason: c.reason, by: GATE_BY_AUTO, action: c.action, scope: c.scope, at });
      row.effect = r.ok ? "paused" : "failed";
      row.scope = c.scope;
      row.gateBy = GATE_BY_AUTO;
      if (!r.ok) row.error = r.error;
    } else {
      row.effect = "suggested";
      row.note = "压缩/切模型/冻结会改用户现场，仍由调用方按建议执行";
    }
    executed.push(row);
  }

  // ⑤ 落账：有执行 / 同一 actionKey 且待人工清单没变时不重复写（30 分钟内）
  const pendingKey = pendingHuman.map((x) => x.action).sort().join(",");
  const lastRow = readActionLog(root, { limit: 1 })[0] || null;
  const sameState = Boolean(
    lastRow && String(lastRow.by || "") === "auto" && Number(lastRow.at || 0)
    && String(lastRow.key || "") === key
    && at - Number(lastRow.at) < cooldownMs
    && String(lastRow.pendingKey || "") === pendingKey
    && !executed.length,
  );
  let recorded = false;
  if (!sameState && (executed.length || pendingHuman.length)) {
    recorded = appendAutoLog(root, { at, key, trigger, level: a.level, score: a.score, executed, pendingHuman, skipped, pendingKey });
  }
  return { ok: true, at, level: a.level, score: a.score, trigger, key, executed, pendingHuman, skipped, released: [], recorded, limit: max };
}

/**
 * 一步到位：读盘 → 评估 → 只执行 low。挂在 10 分钟循环里（每次最多一个动作）。
 */
export function assessAndApplyLowRisk(wsRoot, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const assessment = assessWorkspace(wsRoot, { now, contextWindow: opts.contextWindow });
  const result = applyLowRiskOnly({ ...opts, wsRoot, assessment, now });
  return { assessment, result };
}

/**
 * 一步到位：读盘 → 评估 → 执行全部动作（含 medium/high）。给"有人点一下"的 POST 用。
 * 查询接口是只读的，不调这个。
 */
export function assessAndApply(wsRoot, { now = Date.now(), by = "degradation", contextWindow = 0 } = {}) {
  const assessment = assessWorkspace(wsRoot, { now, contextWindow });
  const result = applyActions({ wsRoot, assessment, now, by });
  return { assessment, result };
}

/** 查询接口的一整个返回体（只读）。 */
export function degradationSnapshot(wsRoot, { now = Date.now(), limit = 20, contextWindow = 0 } = {}) {
  const assessment = assessWorkspace(wsRoot, { now, contextWindow });
  return {
    ok: true,
    at: Number(now),
    assessment,
    gate: readPauseGate(wsRoot),
    // 看板要的：现在挂着哪些闸、谁挂的、什么时候挂的
    activeActions: activeActions(wsRoot),
    // 自动执行的边界也回给前端，别让人以为"系统什么都会自己动"
    auto: {
      risk: AUTO_RISK,
      humanOnly: [...HUMAN_ONLY_ACTIONS],
      actionCooldownMs: AUTO_ACTION_COOLDOWN_MS,
      gateBy: GATE_BY_AUTO,
    },
    // 定时任务静默失败（与 reasons 里那几条同源）
    scheduled: assessment.scheduled || null,
    actions: readActionLog(wsRoot, { limit }),
    thresholds: THRESHOLDS,
    ladder: Object.entries(ACTIONS).map(([action, def]) => ({ action, ...def })),
  };
}
