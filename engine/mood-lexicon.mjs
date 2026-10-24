// engine/mood-lexicon.mjs —— 33 种心情词表 + 坐标（2026-10-24）
//
// 之前元枢只有 10 个基础情绪（EMO_ZH），表达"委屈/得意/吃醋/恋慕"这类复合心情只能靠模型自由发挥。
// 这里给每个词一个 VAD 坐标（效价 v、唤醒 a、支配 d），用最近邻把当前情绪状态落到一个**具体的中文词**上，
// 同时保留基础情绪码——算法不变，只多一层"说得更准"的词表。
//
// 分类沿用 dsh-mood 的三层（基础 11 / 复合 18 / 当代 4），但坐标是我们自己的 VAD 语义。
export const MOOD_33 = [
  // 基础 11
  { code: 'calm', zh: '平静', layer: 'base', v: 0.52, a: 0.30, d: 0.50 },
  { code: 'happy', zh: '开心', layer: 'base', v: 0.80, a: 0.55, d: 0.60 },
  { code: 'curious', zh: '好奇', layer: 'base', v: 0.62, a: 0.62, d: 0.50 },
  { code: 'focused', zh: '专注', layer: 'base', v: 0.58, a: 0.45, d: 0.62 },
  { code: 'excited', zh: '兴奋', layer: 'base', v: 0.82, a: 0.82, d: 0.60 },
  { code: 'tired', zh: '疲惫', layer: 'base', v: 0.38, a: 0.18, d: 0.35 },
  { code: 'anxious', zh: '焦虑', layer: 'base', v: 0.28, a: 0.75, d: 0.30 },
  { code: 'sad', zh: '低落', layer: 'base', v: 0.22, a: 0.25, d: 0.30 },
  { code: 'angry', zh: '生气', layer: 'base', v: 0.18, a: 0.78, d: 0.62 },
  { code: 'fear', zh: '恐惧', layer: 'base', v: 0.12, a: 0.80, d: 0.18 },
  { code: 'surprised', zh: '惊讶', layer: 'base', v: 0.55, a: 0.80, d: 0.40 },
  // 复合 18
  { code: 'wronged', zh: '委屈', layer: 'complex', v: 0.25, a: 0.45, d: 0.22 },
  { code: 'sulky', zh: '生闷气', layer: 'complex', v: 0.30, a: 0.35, d: 0.40 },
  { code: 'proud', zh: '得意', layer: 'complex', v: 0.78, a: 0.50, d: 0.78 },
  { code: 'downcast', zh: '消沉', layer: 'complex', v: 0.20, a: 0.20, d: 0.25 },
  { code: 'worried', zh: '焦虑不安', layer: 'complex', v: 0.30, a: 0.68, d: 0.30 },
  { code: 'numb', zh: '麻木', layer: 'complex', v: 0.45, a: 0.15, d: 0.48 },
  { code: 'lonely', zh: '孤单', layer: 'complex', v: 0.28, a: 0.28, d: 0.30 },
  { code: 'flutter', zh: '心动', layer: 'complex', v: 0.76, a: 0.68, d: 0.45 },
  { code: 'fond', zh: '恋慕', layer: 'complex', v: 0.82, a: 0.50, d: 0.50 },
  { code: 'jealous', zh: '吃醋', layer: 'complex', v: 0.38, a: 0.62, d: 0.35 },
  { code: 'ashamed', zh: '羞耻', layer: 'complex', v: 0.22, a: 0.55, d: 0.20 },
  { code: 'guilty', zh: '内疚', layer: 'complex', v: 0.25, a: 0.40, d: 0.30 },
  { code: 'awkward', zh: '尴尬', layer: 'complex', v: 0.35, a: 0.52, d: 0.30 },
  { code: 'sympathy', zh: '同情', layer: 'complex', v: 0.48, a: 0.35, d: 0.50 },
  { code: 'disappointed', zh: '失望', layer: 'complex', v: 0.25, a: 0.32, d: 0.28 },
  { code: 'nostalgic', zh: '怀旧', layer: 'complex', v: 0.58, a: 0.28, d: 0.45 },
  { code: 'playful', zh: '撒娇', layer: 'complex', v: 0.72, a: 0.55, d: 0.45 },
  { code: 'conflicted', zh: '矛盾', layer: 'complex', v: 0.45, a: 0.55, d: 0.35 },
  // 当代 4
  { code: 'churn', zh: '内耗', layer: 'modern', v: 0.35, a: 0.55, d: 0.25 },
  { code: 'overwhelmed', zh: '破防', layer: 'modern', v: 0.18, a: 0.72, d: 0.20 },
  { code: 'slack', zh: '摆烂', layer: 'modern', v: 0.40, a: 0.12, d: 0.40 },
  { code: 'hyped', zh: '上头', layer: 'modern', v: 0.70, a: 0.85, d: 0.55 },
];

const BY_CODE = new Map(MOOD_33.map((m) => [m.code, m]));

/** 基础情绪码 → 最接近的词（保证旧码也能显示成中文） */
const BASE_ALIAS = { loving: 'fond', neutral: 'calm', lonely: 'lonely' };

/**
 * 把当前情绪状态落到词表里的一个具体词。
 * 权重：效价最重要（心情好坏），唤醒次之，支配最后；残留（warmth/hurt/curiosity）做小幅偏移。
 */
export function labelForState(state = {}) {
  const v = Number.isFinite(Number(state.v)) ? Number(state.v) : 0.5;
  const a = Number.isFinite(Number(state.a)) ? Number(state.a) : 0.4;
  const d = Number.isFinite(Number(state.d)) ? Number(state.d) : 0.5;
  const warmth = Number(state.warmth) || 0;
  const hurt = Number(state.hurt) || 0;
  const curiosity = Number(state.curiosity) || 0;
  // 残留影响：暖 → 偏向亲密词；受伤 → 偏向负面词；好奇 → 偏向探索词
  const vAdj = v + warmth * 0.12 - hurt * 0.18;
  const aAdj = a + curiosity * 0.10;
  let best = null;
  let bestDist = Infinity;
  for (const m of MOOD_33) {
    const dv = (vAdj - m.v) * 2.0;
    const da = (aAdj - m.a) * 1.0;
    const dd = (d - m.d) * 0.6;
    const dist = dv * dv + da * da + dd * dd;
    if (dist < bestDist) { bestDist = dist; best = m; }
  }
  return best || BY_CODE.get('calm');
}

/** 兼容：把任意旧情绪码（calm/happy/loving…）换成词表里的中文 */
export function zhForCode(code) {
  const key = BASE_ALIAS[code] || code;
  return BY_CODE.get(key)?.zh || BY_CODE.get('calm').zh;
}

export function moodByLayer(layer) { return MOOD_33.filter((m) => m.layer === layer) }
