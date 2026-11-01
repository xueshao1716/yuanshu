// ===== brain-regions.mjs —— 8 个脑区，这次是真实旋钮（2026-11-01）=====
//
// 原始设计（xi-system/src/brain.rs）里 8 个区只是 8 个永远 0.5 的权重，
// 唯一用途是拼进系统提示 —— 装饰。
//
// 这里把它变成真旋钮：每个区绑定一个现存机制，改权重就改行为：
//   verification → 交付门严格度（声明已验证算不算数 / 是否降级为 YELLOW）
//   memory       → 反思蒸馏条数上限（1..3）
//   social       → 离开提醒冷却（2..8 小时）
//   analysis     → 单轮工具回合上限（12..28）
//   planning     → 长任务自动落 plan 的阈值（暂为建议值，未接线）
//   tooling      → 高级工具暴露（暂为建议值，未接线）
//   coordination → 多代理并发（暂为建议值，未接线）
//   genesis      → 进化提案频率（暂为建议值，未接线）
import fs from "node:fs";
import path from "node:path";

export const REGIONS_REL = path.join("记忆", "运行时", "脑区.json");

export const REGIONS = [
  { id: "analysis", name: "分析", desc: "拆问题、找根因的深度", knob: "单轮工具回合上限（已换算，未接线）", wired: false },
  { id: "planning", name: "规划", desc: "想几步、列步骤的倾向", knob: "长任务自动落 plan（建议值，未接线）", wired: false },
  { id: "verification", name: "验证", desc: "交付前检查的严格度", knob: "交付门严格度：高=声明已验证不算数", wired: true },
  { id: "memory", name: "记忆", desc: "回看历史、联想强度", knob: "反思蒸馏条数上限 1–3", wired: true },
  { id: "tooling", name: "工具", desc: "动手查/跑 vs 凭经验的偏好", knob: "高级工具暴露（建议值，未接线）", wired: false },
  { id: "social", name: "社交", desc: "主动找你的意愿与热度", knob: "离开提醒冷却 2–8 小时", wired: true },
  { id: "coordination", name: "协作", desc: "多任务/多代理的统筹", knob: "多代理并发（建议值，未接线）", wired: false },
  { id: "genesis", name: "创造", desc: "生成新路径、非标准解", knob: "进化提案频率（建议值，未接线）", wired: false },
];

export const REGION_IDS = REGIONS.map((r) => r.id);
const DEFAULT = 0.5;

export function regionsPath(wsRoot) {
  return path.join(String(wsRoot || "."), REGIONS_REL);
}

function clamp01(n, fallback = DEFAULT) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(1, Math.max(0, x));
}

/** 读权重；文件不存在就播种默认值。 */
export function readRegions(wsRoot) {
  const file = regionsPath(wsRoot);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = {};
    for (const id of REGION_IDS) out[id] = clamp01(raw?.[id], DEFAULT);
    return { ok: true, weights: out, source: "file", updatedAt: Number(raw?.updatedAt) || 0 };
  } catch (e) {
    if (e?.code === "ENOENT") {
      const weights = Object.fromEntries(REGION_IDS.map((id) => [id, DEFAULT]));
      try { writeRegions(wsRoot, weights) } catch {}
      return { ok: true, weights, source: "seeded", updatedAt: 0 };
    }
    return { ok: true, weights: Object.fromEntries(REGION_IDS.map((id) => [id, DEFAULT])), source: "default", error: String(e?.message || e).slice(0, 120) };
  }
}

/** 写权重（可局部更新）。 */
export function writeRegions(wsRoot, patch = {}, { now = Date.now() } = {}) {
  const current = (() => {
    try { return JSON.parse(fs.readFileSync(regionsPath(wsRoot), "utf8")) } catch { return {} }
  })();
  const next = {};
  for (const id of REGION_IDS) next[id] = clamp01(patch[id] ?? current?.[id], DEFAULT);
  // 未知键直接忽略（避免往里塞乱七八糟的东西）
  try {
    fs.mkdirSync(path.dirname(regionsPath(wsRoot)), { recursive: true });
    fs.writeFileSync(regionsPath(wsRoot), JSON.stringify({ ...next, updatedAt: now }, null, 2), "utf8");
    return { ok: true, weights: next, updatedAt: now };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

// ── 各旋钮的语义换算（纯函数，好测）──

/** 验证严格度：≥0.7 时"声明已验证"不再算覆盖；≤0.3 时声明即视为覆盖。 */
export function deliveryStrictness(weights) {
  const w = clamp01(weights?.verification, DEFAULT);
  return w >= 0.7 ? "strict" : w <= 0.3 ? "loose" : "normal";
}

/** 反思最多写几条：0 → 1 条，1 → 3 条。 */
export function distillLimit(weights) {
  const w = clamp01(weights?.memory, DEFAULT);
  return Math.max(1, Math.min(3, Math.round(1 + w * 2)));
}

/** 离开提醒冷却毫秒：0 → 8 小时（少打扰），1 → 2 小时。 */
export function nudgeCooldownMs(weights) {
  const w = clamp01(weights?.social, DEFAULT);
  const hours = 8 - w * 6;
  return Math.round(hours * 60 * 60 * 1000);
}

/** 单轮工具回合上限：0 → 12，1 → 28。 */
export function maxToolTurns(weights) {
  const w = clamp01(weights?.analysis, DEFAULT);
  return Math.max(6, Math.min(40, Math.round(12 + w * 16)));
}
