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
  { id: "analysis", name: "分析", desc: "拆问题、找根因的深度", knob: "单轮工具回合上限 12–28 轮", wired: true },
  { id: "planning", name: "规划", desc: "想几步、列步骤的倾向", knob: "一次连续推进的批次大小 ×0.5–1.5", wired: true },
  { id: "verification", name: "验证", desc: "交付前检查的严格度", knob: "交付门严格度：高=声明已验证不算数", wired: true },
  { id: "memory", name: "记忆", desc: "回看历史、联想强度", knob: "反思蒸馏条数上限 1–3", wired: true },
  { id: "tooling", name: "工具", desc: "动手查/跑 vs 凭经验的偏好", knob: "工具档：<0.35 只留基础工具", wired: true },
  { id: "social", name: "社交", desc: "主动找你的意愿与热度", knob: "离开提醒冷却 2–8 小时", wired: true },
  { id: "coordination", name: "协作", desc: "多任务/多代理的统筹", knob: "多代理并发（子进程模型，暂不接线）", wired: false },
  { id: "genesis", name: "创造", desc: "生成新路径、非标准解", knob: "每日「今日建议」条数 1–5", wired: true },
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

/** 规划权重 → 一次连续推进的批次放大系数：0 → 0.5，1 → 1.5。 */
export function planBatchFactor(weights) {
  const w = clamp01(weights?.planning, DEFAULT);
  return Number((0.5 + w).toFixed(2));
}

/** 工具权重 → 工具档。低档只留基础工具（读/写/改/搜/跑/通知）。 */
export function toolTier(weights) {
  const w = clamp01(weights?.tooling, DEFAULT);
  return w < 0.35 ? "basic" : "full";
}

/** 高级工具：基础档里不出现。 */
export const ADVANCED_TOOLS = new Set([
  "computer_use", "cultivation", "generate_music",
  "share_project", "run_detached", "dsh_task", "delegate_team", "delegate_task", "delegate_fork",
  "design_commission", "website_build", "ui_design", "design_prefs", "design_research",
  "story_project", "story_run", "story_storyboard", "story_adapt", "story_film",
  "canvas", "canvas_read", "canvas_write", "music_login", "music_search", "music_play",
  "promise_make", "promise_close",
  // 2026-11-06 实测（42 个工具名）：下面这些在普通聊天里几乎不出现
  "run_code", "generate_tts", "commission", "time_task", "plan_files",
  "job_status", "output_check", "candidate_compare", "record_taste",
]);

/** 前缀类重工具：故事工坊 / 画布 / 音乐 / 调研 / 设计委托 / 培养。 */
const ADVANCED_PREFIXES = [
  /^story_/, /^canvas/, /^music_/, /^commission_/, /^research_/, /^design_/, /^cultivation/,
  // MCP 工具与 toolpack 工具：数量多、单个体积也不小，普通聊天用不到
  /^mcp_/, /^tp_/,
];

const isAdvancedTool = (name) => ADVANCED_TOOLS.has(name) || ADVANCED_PREFIXES.some((re) => re.test(name));

/** 按工具档过滤 schema 列表（保留函数名与结构，不认识的工具默认保留）。 */
export function filterToolsByTier(tools = [], weights) {
  // 2026-11-06：以前只有"基础档"才裁，默认档会把 55 个工具全发出去（每次 1.7 万 token）。
  // 现在反过来：默认裁掉重组；只有分析权重很高（明确要做复杂多步任务）时才全开。
  const keepAll = Number(weights?.tooling) >= 0.7;
  if (keepAll) return tools;
  const out = tools.filter((t) => {
    const name = t?.function?.name || t?.name || "";
    return !isAdvancedTool(name);
  });
  return out.length ? out : tools;
}

/** 创造权重 → 每日建议条数：0 → 1，1 → 5。 */
export function ideaCap(weights) {
  const w = clamp01(weights?.genesis, DEFAULT);
  return Math.max(1, Math.min(5, Math.round(1 + w * 4)));
}
