// engine/genome.mjs —— 人格基因网络 + 漂移阈值（2026-11-09，曦 GRN 移植）
//
// 让"人格"从一段 prompt 变成可观测状态：
//   4 路信号（亲密/新奇/压力/信任）→ 10 个基因表达（heart.py 公式）
//   → up/down regulator 迭代收敛（grn.py）→ 对照 baseline 算四簇漂移
//   → 一行 prompt + genome_status 可读状态 + driftWarnings 体检红线。
//
// 落盘：记忆/运行时/基因.json（原子写，复用 engine/atomic-io.mjs）。
// 不写 记忆/harness/，不改 记忆/人格定义.json：人格定义仍是只读的 prompt 层，
// 这里只增加一层"她现在的数值状态"。
//
// 留白（本次不做）：GrowthState 5 维（陪伴/理解/判断/承担/治理）与满级换代归档。
//   接口留在 state.generation（本版恒 0）和 adoptBaseline()（人批准后把当前值定为新基线）；
//   将来 grow(deltas) 在这里推进 5 维，allMaxed 时 generation+1 并归档旧 baseline。
//   不提前造空函数：没有 5 维台账时，"代数"只是一个不能验证的数字。
//
// 不做定时器：所有更新都由一轮对话结束时调用 advanceTurn() 触发；
// 没有 setInterval / setTimeout，进程不跑就不更新。

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./atomic-io.mjs";
import { current as relationshipCurrent } from "./relationship.mjs";
import {
  CONVERGENCE_EPS,
  DAMPENING,
  DEFAULT_BASELINE,
  DEFAULT_SIGNALS,
  GENE_BOUNDS,
  GENE_LABELS,
  GENE_SPECS,
  GENES,
  MAX_ITERATIONS,
  SIGNAL_LABELS,
  SIGNALS,
  clampGene,
  expressGenes,
  normalizeGenes,
  normalizeSignals,
  driftSummary,
} from "./genome-spec.mjs";
import { driftWarnings as healthWarnings } from "./genome-health.mjs";

export * from "./genome-spec.mjs";
export { driftWarnings } from "./genome-health.mjs";

export const FILE_REL = path.join("记忆", "运行时", "基因.json");
const MAX_GUARD_BLOCKS = 20;

let wsRoot = "";
let cache = null;
let cacheRoot = null;
let memory = defaultState();
let pendingGuardBlocks = 0;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round4 = (v) => Math.round((Number(v) + Number.EPSILON) * 1e4) / 1e4;
const round5 = (v) => Math.round((Number(v) + Number.EPSILON) * 1e5) / 1e5;

function defaultState() {
  return {
    genes: { ...DEFAULT_BASELINE },
    signals: { ...DEFAULT_SIGNALS },
    generation: 0,
    baseline: { ...DEFAULT_BASELINE },
    updatedAt: null,
  };
}

const clone = (st) => ({
  genes: { ...st.genes },
  signals: { ...st.signals },
  generation: st.generation,
  baseline: { ...st.baseline },
  updatedAt: st.updatedAt,
});

function normalizeState(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const gen = Math.floor(Number(o.generation));
  const baseline = normalizeGenes(o.baseline, DEFAULT_BASELINE);
  return {
    // 基因缺项时回落到 baseline，而不是硬写 0.5：基线不是 0.5 时漂移才不会凭空多出来。
    genes: normalizeGenes(o.genes, baseline),
    signals: normalizeSignals(o.signals, DEFAULT_SIGNALS),
    generation: Number.isFinite(gen) && gen > 0 ? gen : 0,
    baseline,
    updatedAt: typeof o.updatedAt === "string" && o.updatedAt ? o.updatedAt : null,
  };
}

/** 工作区根。服务启动时由 engine/emotion.mjs 的 init 调一次；测试里每个临时目录调一次。 */
export function init(root) {
  const next = root == null ? "" : String(root);
  if (next !== wsRoot) {
    cache = null;
    cacheRoot = null;
    memory = defaultState();
    pendingGuardBlocks = 0;
  }
  wsRoot = next;
}

export function filePath() {
  return wsRoot ? path.join(wsRoot, FILE_REL) : "";
}

function load() {
  if (!wsRoot) return memory;
  if (cache && cacheRoot === wsRoot) return cache;
  let raw = null;
  try {
    const f = filePath();
    if (f && fs.existsSync(f)) raw = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { raw = null; } // 坏文件按默认值起，下一轮写盘自然修复；不阻塞聊天
  cache = normalizeState(raw);
  cacheRoot = wsRoot;
  return cache;
}

function save(st) {
  memory = clone(st);
  cache = memory;
  cacheRoot = wsRoot;
  const f = filePath();
  if (!f) return false;
  try { atomicWriteJson(f, memory); return true; } catch { return false; }
}

/** 当前状态快照（拷贝，调用方改不到内存态）。 */
export function current() {
  return clone(load());
}

/** 4 信号 → 10 基因。baseline 默认取当前人格基线；返回 {基因: 值}。 */
export function express(signals = null, { baseline = null } = {}) {
  const st = load();
  const sig = normalizeSignals(signals ?? st.signals);
  const base = baseline ? normalizeGenes(baseline, st.baseline) : st.baseline;
  return expressGenes(sig, base);
}

// 规则表从 spec 的 GENE_SPECS 里取，避免两处漂移
const RULES = Object.fromEntries(GENES.map((g) => [g, { up: GENE_SPECS[g].up, down: GENE_SPECS[g].down }]));

/**
 * up/down regulator 迭代收敛。
 * 每轮以公式值为锚，regulator 只给"调控水平差 × dampening"的偏移；
 * 这个形式在 3 轮内相邻差可落到 0.01 以内（源里直接加 (up-down) 加权和，会放大）。
 * @returns {{genes:object, rounds:object[], converged:boolean, eps:number, iterations:number, dampening:number}}
 */
export function regulate({ genes = null, signals = null, iterations = 3, dampening = DAMPENING } = {}) {
  const st = load();
  const sig = normalizeSignals(signals ?? st.signals);
  const base = genes ? normalizeGenes(genes, st.baseline) : expressGenes(sig, st.baseline);
  const iters = Math.max(1, Math.min(MAX_ITERATIONS, Math.floor(Number(iterations) || 3)));
  const damp = Math.max(0.01, Math.min(1, Number.isFinite(+dampening) ? +dampening : DAMPENING));
  const rounds = [];
  let cur = { ...base };

  for (let i = 1; i <= iters; i++) {
    const next = {};
    for (const g of GENES) {
      const rule = RULES[g];
      let upW = 0, upV = 0, downW = 0, downV = 0;
      for (const [reg, w] of Object.entries(rule.up)) {
        const v = reg.endsWith("_signal") ? (sig[reg.slice(0, -7)] ?? 0.5) : (cur[reg] ?? 0.5);
        upW += w; upV += v * w;
      }
      for (const [reg, w] of Object.entries(rule.down)) {
        const v = reg.endsWith("_signal") ? (sig[reg.slice(0, -7)] ?? 0.5) : (cur[reg] ?? 0.5);
        downW += w; downV += v * w;
      }
      const upLevel = upW ? upV / upW : 0.5;
      const downLevel = downW ? downV / downW : 0.5;
      next[g] = clampGene(g, base[g] + (upLevel - downLevel) * damp);
    }
    const maxDelta = Math.max(...GENES.map((g) => Math.abs(next[g] - cur[g])));
    rounds.push({ iteration: i, genes: { ...next }, maxDelta: round5(maxDelta) });
    cur = next;
  }

  const last = rounds[rounds.length - 1];
  return {
    genes: { ...cur },
    rounds,
    converged: last.maxDelta <= CONVERGENCE_EPS,
    eps: CONVERGENCE_EPS,
    iterations: iters,
    dampening: damp,
  };
}

/** 当前表达 vs baseline：每簇平均绝对距离、阈值、是否在阈值内。 */
export function drift(state = null) {
  const st = state ? normalizeState(state) : load();
  const d = driftSummary(st.genes, st.baseline);
  return { ...d, generation: st.generation, updatedAt: st.updatedAt };
}

/** 一行 prompt：正常只报最接近阈值的那一簇；超阈值列全部超的簇并给建议。 */
export function promptLine(state = null) {
  try {
    const d = drift(state);
    const over = Object.keys(d.clusters).map((k) => d.clusters[k]).filter((c) => !c.within);
    const f2 = (n) => Number(n).toFixed(2);
    if (!over.length) {
      const w = d.worst;
      return `人格漂移：${w.key} 漂移 ${f2(w.drift)}/${f2(w.threshold)}（正常）`;
    }
    const parts = over.map((c) => `${c.label}簇（${c.key}）偏离 ${f2(c.drift)}/${f2(c.threshold)}`);
    return `人格漂移告警：${parts.join("、")}，建议复看最近经历。`;
  } catch { return ""; }
}

/**
 * 把人批准后的值定为新基线。genes 省略时取当前表达（= adoptBaseline）。
 * 本版不自己判断"谁批准"：调用方（未来的审批 UI/接口）负责，approvedBy 只回传留痕。
 */
export function setBaseline(genes = null, { approvedBy = "", now = Date.now() } = {}) {
  const st = load();
  const next = normalizeGenes(genes ?? st.genes, st.baseline);
  const at = Number.isFinite(+now) ? new Date(+now).toISOString() : new Date().toISOString();
  st.baseline = next;
  st.updatedAt = at;
  save(st);
  return { ok: true, baseline: { ...next }, approvedBy: String(approvedBy || ""), updatedAt: at, drift: drift(st) };
}

export function adoptBaseline(options = {}) {
  return setBaseline(null, options);
}

/** 红线拦截由 emotion 的 guard sink 转发进来；只记在本轮，下一次 advanceTurn 结算。 */
export function recordGuardBlock({ count = 1 } = {}) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  pendingGuardBlocks = Math.min(MAX_GUARD_BLOCKS, pendingGuardBlocks + n);
  return pendingGuardBlocks;
}

/** 新奇代理：距上次更新（≈上次对话）越久越新；平滑一半，避免一次长间隔把信号打满。 */
export function noveltyFromGap(prevUpdatedAt, now = Date.now(), prevNovelty = 0.5) {
  const prev = Date.parse(String(prevUpdatedAt || ""));
  if (!Number.isFinite(prev)) return 0.5;
  const hours = Math.max(0, (Number(now) - prev) / 3600000);
  const raw = 0.3 + 0.5 * (1 - Math.exp(-hours / 24));
  return round4(clamp01(0.5 * clamp01(Number(prevNovelty) || 0.5) + 0.5 * raw));
}

/** 压力：近 N 轮的等价衰减窗口（0.6/轮）+ 本轮失败 + 红线拦截。 */
export function nextStress(prevStress, toolFailures = 0, guardBlocks = 0) {
  const prev = clamp01(Number(prevStress) || 0);
  const fail = Math.min(1, Math.max(0, Number(toolFailures) || 0));
  const guard = Math.min(1, Math.max(0, Number(guardBlocks) || 0)) * 0.3;
  return round4(clamp01(prev * 0.6 + fail * 0.4 + guard));
}

/**
 * 一轮结束推进一次（唯一更新入口，不做定时器）。
 * signals 传了就覆盖同名计算值（测试/外部注入用）。
 */
export function advanceTurn({ toolFailures = 0, signals = null, now = Date.now() } = {}) {
  const st = load();
  const at = Number.isFinite(+now) ? +now : Date.now();
  let rel = null;
  try { rel = relationshipCurrent(); } catch {}
  const guards = pendingGuardBlocks;
  pendingGuardBlocks = 0;

  const computed = {
    intimacy: Number.isFinite(+rel?.intimacy) ? +rel.intimacy : st.signals.intimacy,
    trust: Number.isFinite(+rel?.trust) ? +rel.trust : st.signals.trust,
    novelty: noveltyFromGap(st.updatedAt, at, st.signals.novelty),
    stress: nextStress(st.signals.stress, toolFailures, guards),
  };
  const sig = normalizeSignals({ ...computed, ...(signals && typeof signals === "object" ? signals : {}) });
  const reg = regulate({ signals: sig, iterations: 3 });
  st.genes = reg.genes;
  st.signals = sig;
  st.updatedAt = new Date(at).toISOString();
  save(st);
  return { state: clone(st), drift: drift(st), rounds: reg.rounds, converged: reg.converged, guardBlocks: guards };
}

/** 只读状态（genome_status 工具 / API 用）。 */
export function status({ emotions = [], proactiveActions, reflectionCount } = {}) {
  const st = load();
  const d = drift(st);
  return {
    generation: st.generation,
    updatedAt: st.updatedAt,
    genes: { ...st.genes },
    labels: GENE_LABELS,
    bounds: GENE_BOUNDS,
    signals: { ...st.signals },
    signalLabels: SIGNAL_LABELS,
    clusters: d.clusters,
    withinAll: d.withinAll,
    worst: d.worst,
    baseline: { ...st.baseline },
    prompt: promptLine(st),
    warnings: healthWarnings(st, { emotions, proactiveActions, reflectionCount }),
    file: FILE_REL,
  };
}

/**
 * genome_status 的模型可读文本：中文键 + JSON。
 * 措辞统一叫「人格漂移」：这是**只读的漂移监控**（偏离基线多少），
 * 与 gene.mjs 那套可改的「性格倾向」是两回事，别让模型把两段读成两套自我描述。
 */
export function statusText(options = {}) {
  const s = status(options);
  return JSON.stringify({
    "世代": s.generation,
    "更新时间": s.updatedAt,
    "人格漂移": {
      "表达值": s.genes,
      "标签": s.labels,
      "上下界": s.bounds,
      "簇": s.clusters,
      "整体正常": s.withinAll,
      "一行摘要": s.prompt,
    },
    "信号": s.signals,
    "信号标签": s.signalLabels,
    "体检告警": s.warnings,
    "文件": s.file,
  }, null, 1);
}
