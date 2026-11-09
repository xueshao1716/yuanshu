// engine/genome-spec.mjs —— 曦 GRN 的基因表（纯函数，无 IO）
//
// 来源：D:\xinyu\kernel\heart.py:90-125（10 基因 × 4 信号的线性公式）
//       D:\xinyu\state\grn.py:22-80（基因簇 / 每簇阈值 / up-down 调控规则）
//
// 源里的 lowerBounds/upperBounds 默认是空对象，只做 0..1 夹紧。这里按簇补了保守硬边界：
// 核心认同簇下限 0.20（忠诚 0.30）防止人格塌陷，表达/治理簇上限 0.90 防止贴顶后失去分辨率；
// 认知簇 0.10-0.95。边界只在表达越界时生效，平时不改变公式结果。
//
// 这里只放"可计算的规格"，落盘/读取/推进在 engine/genome.mjs。

export const GENES = [
  "gentleness", "initiative", "curiosity", "attachment", "learning",
  "creativity", "caution", "humor", "loyalty", "autonomy_bias",
];

export const GENE_LABELS = Object.freeze({
  gentleness: "温柔",
  initiative: "主动",
  curiosity: "好奇",
  attachment: "依恋",
  learning: "学习",
  creativity: "创造",
  caution: "谨慎",
  humor: "幽默",
  loyalty: "忠诚",
  autonomy_bias: "自主",
});

export const SIGNALS = ["intimacy", "novelty", "stress", "trust"];

export const SIGNAL_LABELS = Object.freeze({
  intimacy: "亲密",
  novelty: "新奇",
  stress: "压力",
  trust: "信任",
});

// 与 heart.py GenomeState 默认信号一致：压力默认 0.1，其余 0.5。
export const DEFAULT_SIGNALS = Object.freeze({
  intimacy: 0.5, novelty: 0.5, stress: 0.1, trust: 0.5,
});

export const DEFAULT_BASELINE = Object.freeze(Object.fromEntries(GENES.map((g) => [g, 0.5])));

// 基因簇 / 漂移阈值：grn.py:29-34。
// 漂移口径改为"相对 baseline 的平均绝对距离"（源里是 abs(avg-0.5)）；
// 平均距离不会被单个基因的极端值放大，和"漂移 0.06/0.15"这种小数口径也更贴。
export const CLUSTERS = Object.freeze({
  core_identity: Object.freeze({ label: "核心认同", genes: ["gentleness", "loyalty", "attachment"], threshold: 0.15 }),
  cognitive: Object.freeze({ label: "认知", genes: ["learning", "curiosity", "creativity"], threshold: 0.20 }),
  expressive: Object.freeze({ label: "表达", genes: ["initiative", "humor"], threshold: 0.18 }),
  governance: Object.freeze({ label: "治理", genes: ["caution", "autonomy_bias"], threshold: 0.12 }),
});

// 每个基因：公式、硬边界、中文标签、所属簇、GRN 调控规则（grn.py:39-80 原样搬）。
// formula 是给人看的字符串；fn 是唯一实现，测试对 fn 做单调性/边界断言。
export const GENE_SPECS = Object.freeze({
  gentleness: {
    label: "温柔", cluster: "core_identity", lower: 0.20, upper: 0.95,
    formula: "b + intimacy×0.15 + trust×0.10 − stress×0.10",
    fn: (b, s) => b + s.intimacy * 0.15 + s.trust * 0.10 - s.stress * 0.10,
    up: { attachment: 0.3, loyalty: 0.2, caution: 0.15 },
    down: { autonomy_bias: 0.2, initiative: 0.1 },
  },
  initiative: {
    label: "主动", cluster: "expressive", lower: 0.10, upper: 0.90,
    formula: "b + novelty×0.12 − stress×0.18",
    fn: (b, s) => b + s.novelty * 0.12 - s.stress * 0.18,
    up: { curiosity: 0.25, creativity: 0.2, autonomy_bias: 0.15 },
    down: { caution: 0.3, gentleness: 0.1 },
  },
  curiosity: {
    label: "好奇", cluster: "cognitive", lower: 0.10, upper: 0.95,
    formula: "b + novelty×0.15",
    fn: (b, s) => b + s.novelty * 0.15,
    up: { learning: 0.3, creativity: 0.2, novelty_signal: 0.4 },
    down: { caution: 0.2, stress_signal: 0.3 },
  },
  attachment: {
    label: "依恋", cluster: "core_identity", lower: 0.20, upper: 0.95,
    formula: "b + intimacy×0.12 + trust×0.10",
    fn: (b, s) => b + s.intimacy * 0.12 + s.trust * 0.10,
    up: { gentleness: 0.25, loyalty: 0.3, intimacy_signal: 0.35 },
    down: { autonomy_bias: 0.2, initiative: 0.1 },
  },
  learning: {
    label: "学习", cluster: "cognitive", lower: 0.10, upper: 0.95,
    formula: "b + novelty×0.10 + (1 − stress)×0.08",
    fn: (b, s) => b + s.novelty * 0.10 + (1 - s.stress) * 0.08,
    up: { curiosity: 0.3, creativity: 0.15, novelty_signal: 0.3 },
    down: { caution: 0.1, stress_signal: 0.2 },
  },
  creativity: {
    label: "创造", cluster: "cognitive", lower: 0.10, upper: 0.95,
    formula: "b + novelty×0.15",
    fn: (b, s) => b + s.novelty * 0.15,
    up: { curiosity: 0.3, learning: 0.2, novelty_signal: 0.25 },
    down: { caution: 0.25, stress_signal: 0.2 },
  },
  caution: {
    label: "谨慎", cluster: "governance", lower: 0.10, upper: 0.90,
    formula: "b + stress×0.20",
    fn: (b, s) => b + s.stress * 0.20,
    up: { stress_signal: 0.4, gentleness: 0.15 },
    down: { curiosity: 0.15, initiative: 0.2, novelty_signal: 0.2 },
  },
  humor: {
    label: "幽默", cluster: "expressive", lower: 0.10, upper: 0.90,
    formula: "b + intimacy×0.08 − stress×0.08",
    fn: (b, s) => b + s.intimacy * 0.08 - s.stress * 0.08,
    up: { gentleness: 0.2, intimacy_signal: 0.25, creativity: 0.15 },
    down: { caution: 0.2, stress_signal: 0.3 },
  },
  loyalty: {
    label: "忠诚", cluster: "core_identity", lower: 0.30, upper: 1.00,
    formula: "b（不随信号变，最稳的一条）",
    fn: (b) => b,
    up: { attachment: 0.3, gentleness: 0.2 },
    down: { autonomy_bias: 0.15, initiative: 0.1 },
  },
  autonomy_bias: {
    label: "自主", cluster: "governance", lower: 0.10, upper: 0.90,
    formula: "b + novelty×0.10 − stress×0.12",
    fn: (b, s) => b + s.novelty * 0.10 - s.stress * 0.12,
    up: { initiative: 0.2, curiosity: 0.15, novelty_signal: 0.2 },
    down: { attachment: 0.25, gentleness: 0.1, loyalty: 0.15 },
  },
});

export const GENE_BOUNDS = Object.freeze(Object.fromEntries(
  GENES.map((g) => [g, Object.freeze({ lower: GENE_SPECS[g].lower, upper: GENE_SPECS[g].upper })]),
));

// heart.py GenomeState.constraints 的同口径导出：{lowerBounds, upperBounds}。
// 源里默认是空对象（只夹 0..1）；这里放的是按簇补的保守硬边界，方便外部按原名读取。
export const LOWER_BOUNDS = Object.freeze(Object.fromEntries(GENES.map((g) => [g, GENE_SPECS[g].lower])));
export const UPPER_BOUNDS = Object.freeze(Object.fromEntries(GENES.map((g) => [g, GENE_SPECS[g].upper])));
export const BOUND_CONSTRAINTS = Object.freeze({ lowerBounds: LOWER_BOUNDS, upperBounds: UPPER_BOUNDS });

// 每轮调控的偏移幅度。源里 dampening=0.3 直接加 (up-down) 加权和，3 轮内不收敛（实测会放大）。
// 这里把 up/down 先归一成 0..1 的"调控水平"再乘 0.2，3 轮相邻差可稳定落到 0.01 以内。
export const DAMPENING = 0.2;
export const CONVERGENCE_EPS = 0.01;
export const MAX_ITERATIONS = 12;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round4 = (v) => Math.round((Number(v) + Number.EPSILON) * 1e4) / 1e4;

export function clampGene(gene, value) {
  const b = GENE_BOUNDS[gene];
  const n = Number.isFinite(+value) ? +value : 0.5;
  if (!b) return round4(clamp01(n));
  return round4(Math.max(b.lower, Math.min(b.upper, clamp01(n))));
}

export function normalizeSignals(input = null, fallback = DEFAULT_SIGNALS) {
  const o = input && typeof input === "object" ? input : {};
  const out = {};
  for (const s of SIGNALS) {
    const v = Number.isFinite(+o[s]) ? +o[s] : Number(fallback?.[s]);
    out[s] = round4(clamp01(Number.isFinite(v) ? v : DEFAULT_SIGNALS[s]));
  }
  return out;
}

export function normalizeGenes(input = null, fallback = DEFAULT_BASELINE) {
  const o = input && typeof input === "object" ? input : {};
  const out = {};
  for (const g of GENES) {
    const v = Number.isFinite(+o[g]) ? +o[g] : Number(fallback?.[g]);
    out[g] = clampGene(g, Number.isFinite(v) ? v : 0.5);
  }
  return out;
}

/** 10 基因 × 4 信号：heart.py GenomeState.express 的逐行移植。 */
export function expressGenes(signals = DEFAULT_SIGNALS, baseline = DEFAULT_BASELINE) {
  const s = normalizeSignals(signals);
  const out = {};
  for (const g of GENES) {
    const spec = GENE_SPECS[g];
    const b = Number.isFinite(+baseline?.[g]) ? clampGene(g, baseline[g]) : 0.5;
    out[g] = clampGene(g, spec.fn(b, s));
  }
  return out;
}

/** 按簇算"当前值 vs 基线"的平均绝对距离；within 用每簇自己的阈值。 */
export function driftSummary(genes = DEFAULT_BASELINE, baseline = DEFAULT_BASELINE) {
  const cur = normalizeGenes(genes, DEFAULT_BASELINE);
  const base = normalizeGenes(baseline, DEFAULT_BASELINE);
  const clusters = {};
  for (const [key, cluster] of Object.entries(CLUSTERS)) {
    const perGene = {};
    let sum = 0;
    for (const g of cluster.genes) {
      const d = Math.abs(cur[g] - base[g]);
      perGene[g] = round4(d);
      sum += d;
    }
    const drift = round4(sum / cluster.genes.length);
    clusters[key] = {
      key,
      label: cluster.label,
      genes: perGene,
      drift,
      threshold: cluster.threshold,
      within: drift <= cluster.threshold + 1e-9,
    };
  }
  const withinAll = Object.values(clusters).every((c) => c.within);
  const worst = Object.values(clusters).sort((a, b) => (b.drift / b.threshold) - (a.drift / a.threshold))[0];
  return { clusters, withinAll, worst };
}
