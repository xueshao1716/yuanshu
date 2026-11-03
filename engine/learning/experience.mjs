// ===== experience.mjs —— 结构化经验（M1 最后一片，2026-11-03）=====
//
// 与 events.jsonl 的分工：
//   events  = 发生了什么（轻量、可聚合）
//   experience = 这件事的完整轨迹（目标/计划/动作/错误/反馈/教训），可指回原始 runId
//
// 纪律：
//   · 必须能追溯（runId 必填，没有就不是经验，只是感想）
//   · 成功与否不许只由自己宣称：success 来自交付门/测试，feedback 来自人
import fs from "node:fs";
import path from "node:path";

export const EXP_REL = path.join("记忆", "进化", "经验.jsonl");

const expPath = (wsRoot) => path.join(String(wsRoot || "."), EXP_REL);
const rid = () => `exp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 归一化成一条经验；不合格返回 ok:false。 */
export function buildExperience(input = {}) {
  const errors = [];
  if (!String(input.runId || "").trim()) errors.push("缺 runId（经验必须能追溯）");
  if (!String(input.goal || "").trim()) errors.push("缺 goal");
  if (typeof input.success !== "boolean") errors.push("success 必须是布尔（来自交付门/测试，不由自己宣称）");
  if (errors.length) return { ok: false, errors };

  const arr = (x) => (Array.isArray(x) ? x.filter(Boolean) : []);
  return {
    ok: true,
    experience: {
      experience_id: rid(),
      at: input.at || new Date().toISOString(),
      agent_id: String(input.agentId || "xiaoyu"),
      run_id: String(input.runId),
      task_type: String(input.taskType || "未分类"),
      goal: String(input.goal).slice(0, 200),
      plan: arr(input.plan).slice(0, 20),
      actions: arr(input.actions).slice(0, 50).map((a) => (typeof a === "string" ? { tool: a } : a)),
      errors: arr(input.errors).slice(0, 20).map((e) => (typeof e === "string" ? { message: e } : e)),
      user_feedback: arr(input.userFeedback).slice(0, 10),
      result: { success: input.success, quality_score: Number.isFinite(Number(input.quality)) ? Number(input.quality) : null },
      lessons: arr(input.lessons).slice(0, 10),
      cost: { minutes: Number.isFinite(Number(input.minutes)) ? Number(input.minutes) : null },
    },
  };
}

/** 落盘（append-only，一行一条）。 */
export function recordExperience(wsRoot, input = {}) {
  const built = buildExperience(input);
  if (!built.ok) return built;
  try {
    fs.mkdirSync(path.dirname(expPath(wsRoot)), { recursive: true });
    fs.appendFileSync(expPath(wsRoot), JSON.stringify(built.experience) + "\n", "utf8");
    return { ok: true, experience: built.experience };
  } catch (e) {
    return { ok: false, errors: [String(e?.message || e).slice(0, 160)] };
  }
}

export function readExperiences(wsRoot, { limit = 500 } = {}) {
  let raw = "";
  try { raw = fs.readFileSync(expPath(wsRoot), "utf8") } catch { return [] }
  return raw.split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean).slice(-limit);
}

/** 简单统计：按类型看成功与失败分布（给画像/诊断用）。 */
export function summarizeExperiences(list = []) {
  const by = new Map();
  for (const e of list) {
    const k = e.task_type || "未分类";
    const row = by.get(k) || { taskType: k, total: 0, success: 0, failed: 0, withLessons: 0 };
    row.total += 1;
    e.result?.success ? (row.success += 1) : (row.failed += 1);
    if ((e.lessons || []).length) row.withLessons += 1;
    by.set(k, row);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}
