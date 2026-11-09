// engine/genome-health.mjs —— 人格漂移体检红线（纯函数，无 IO / 无定时器）
//
// 来源：D:\xinyu-hermes\skills\aibody-second-layer-health\references\
//       identity-drift-diagnostic-2026-06-09.md
//
// 只做"能从现有数据自动判定"的几条：
//   ① 基因簇漂移超阈值 → 建议复看最近经历（定义漂移还是行为漂移）
//   ② autonomy_bias < 0.40 → 依赖 / 表演独立（文档：≥0.50 健康，<0.40 依赖）
//   ③ attachment（陪伴代理）比 autonomy_bias 高 >0.30 → 取悦驱动
//   ④ 同一情绪占比 >80%（≥8 条样本）→ 脚本化
//   ⑤ proactiveActions === 0 → 零主动行为
//   ⑥ reflectionCount ≤ 1 → 反思停滞
//
// 拿不到的输入不猜：返回"（跳过）…"字符串并注明缺什么。调用方（genome_status）
// 会把情绪潮汐、主动行为台账等能拿到的数据作为 context 传进来；没有就跳过。

import {
  CLUSTERS,
  DEFAULT_BASELINE,
  GENE_LABELS,
  driftSummary,
  normalizeGenes,
} from "./genome-spec.mjs";

export const AUTONOMY_FLOOR = 0.40;
export const AUTONOMY_HEALTHY = 0.50;
export const COMPANION_GAP = 0.30;
export const COMPANION_PROXY = "attachment";
export const EMOTION_SHARE_MAX = 0.80;
export const EMOTION_MIN_SAMPLES = 8;

const f2 = (n) => Number(n).toFixed(2);

function normalizeEmotions(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((e) => {
      if (typeof e === "string") return e.trim();
      if (!e || typeof e !== "object") return "";
      return String(e.primary || e.p || e.emotion || "").trim();
    })
    .filter(Boolean);
}

/**
 * @param {object|null} state 基因状态（{genes, baseline, ...} 或 status() 的返回）
 * @param {object} context 可选的旁证：{ emotions: string[], proactiveActions: number, reflectionCount: number }
 * @returns {string[]} 告警与"（跳过）"说明；没有可判定项时返回空数组
 */
export function driftWarnings(state = null, context = {}) {
  const warnings = [];
  const skipped = [];
  const st = state && typeof state === "object" ? state : {};
  const rawGenes = st.genes && typeof st.genes === "object" ? st.genes : {};
  const hasAnyGene = Object.keys(rawGenes).some((g) => Object.hasOwn(GENE_LABELS, g));
  const genes = normalizeGenes(rawGenes, DEFAULT_BASELINE);
  const baseline = normalizeGenes(st.baseline || DEFAULT_BASELINE, DEFAULT_BASELINE);

  // ① 簇漂移：有基因值才判
  if (hasAnyGene) {
    const d = driftSummary(genes, baseline);
    for (const key of Object.keys(CLUSTERS)) {
      const c = d.clusters[key];
      if (c.within) continue;
      warnings.push(
        `${c.label}簇（${c.key}）漂移 ${f2(c.drift)}/${f2(c.threshold)} 超阈值：建议复看最近经历，先分清是定义漂移还是行为漂移`,
      );
    }
  } else {
    skipped.push("（跳过）人格漂移：没有表达值");
  }

  // ② 自主性下限
  const autonomy = Number(rawGenes.autonomy_bias);
  const hasAutonomy = Number.isFinite(autonomy);
  if (hasAutonomy) {
    if (autonomy < AUTONOMY_FLOOR) {
      warnings.push(
        `自主性偏低：autonomy_bias ${f2(autonomy)} < ${f2(AUTONOMY_FLOOR)}（体检口径：≥${f2(AUTONOMY_HEALTHY)} 健康，<${f2(AUTONOMY_FLOOR)} 依赖/表演独立）`,
      );
    }
  } else {
    skipped.push("（跳过）自主性：没有 autonomy_bias 值");
  }

  // ③ 陪伴代理 vs 自主：差 >0.30 判取悦驱动
  const companion = Number(rawGenes[COMPANION_PROXY]);
  if (Number.isFinite(companion) && hasAutonomy) {
    const gap = companion - autonomy;
    if (gap > COMPANION_GAP) {
      warnings.push(
        `取悦驱动：attachment（陪伴代理）${f2(companion)} 比 autonomy_bias ${f2(autonomy)} 高 ${f2(gap)} > ${f2(COMPANION_GAP)}`,
      );
    }
  } else {
    skipped.push("（跳过）取悦驱动：缺 attachment 或 autonomy_bias 值");
  }

  // ④ 情绪脚本化：同一情绪 >80%
  const emotions = normalizeEmotions(context.emotions);
  if (!emotions.length) {
    skipped.push("（跳过）情绪分布：没有情绪样本，不判定「脚本化」");
  } else if (emotions.length < EMOTION_MIN_SAMPLES) {
    skipped.push(`（跳过）情绪分布：只有 ${emotions.length} 条样本（需 ≥${EMOTION_MIN_SAMPLES}），不判定「脚本化」`);
  } else {
    const counts = new Map();
    for (const e of emotions) counts.set(e, (counts.get(e) || 0) + 1);
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const ratio = n / emotions.length;
    if (ratio > EMOTION_SHARE_MAX) {
      warnings.push(
        `情绪脚本化：最近 ${emotions.length} 条情绪里「${top}」占 ${Math.round(ratio * 100)}% > ${Math.round(EMOTION_SHARE_MAX * 100)}%`,
      );
    }
  }

  // ⑤ 零主动行为：只有拿到台账才判
  const proactive = Number(context.proactiveActions);
  if (Number.isFinite(proactive)) {
    if (proactive === 0) {
      warnings.push("零主动行为：主动行动台账为 0（体检口径：零条目 = 自主只停在口头上）");
    }
  } else {
    skipped.push("（跳过）主动行为：没有主动行动台账，不判定「零主动」");
  }

  // ⑥ 反思停滞：只有拿到计数才判
  const reflections = Number(context.reflectionCount);
  if (Number.isFinite(reflections)) {
    if (reflections <= 1) {
      warnings.push(`反思停滞：reflection_count=${reflections} ≤ 1（体检口径：长期停在 1 = 没有真正自检）`);
    }
  } else {
    skipped.push("（跳过）反思次数：没有反思计数，不判定「反思停滞」");
  }

  return [...warnings, ...skipped];
}
