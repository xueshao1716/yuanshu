// ===== self-change-trigger.mjs —— 该不该自改的判断（影子模式）2026-11-02 =====
//
// 只判断"要不要自改、改哪块"，不写代码、不建分支。
// 现在默认 shadow：只记一份拟议提案进面板，等你清醒时再决定是否放开真实改动。
import { readEvents } from "./evolution/index.mjs";

const COOLDOWN_MS = 8 * 3600 * 1000; // 同一目标 8 小时最多提一次
const MIN_FAIL = 3;                   // 至少 3 次失败才认为"是个短板"

/** 从事件流里找短板：按 target/targetId 聚失败的证据。 */
export function findWeakSpots(events = [], { now = Date.now(), windowMs = 72 * 3600 * 1000 } = {}) {
  const since = now - windowMs;
  const rows = new Map();
  for (const e of events) {
    const t = Date.parse(String(e.at || ""));
    if (!Number.isFinite(t) || t < since) continue;
    const v = String(e.verdict || "");
    const bad = ["rollback", "red", "rejected", "lowered"].includes(v);
    if (!bad) continue;
    const key = `${e.target || "unknown"}:${e.targetId || "unknown"}`;
    const row = rows.get(key) || { key, target: e.target || "unknown", targetId: e.targetId || "unknown", fails: 0, taskTypes: new Set(), lastAt: 0 };
    row.fails += 1;
    if (e.taskType) row.taskTypes.add(e.taskType);
    row.lastAt = Math.max(row.lastAt, t);
    rows.set(key, row);
  }
  return [...rows.values()]
    .filter((r) => r.fails >= MIN_FAIL)
    .map((r) => ({ ...r, taskTypes: [...r.taskTypes] }))
    .sort((a, b) => b.fails - a.fails);
}

/**
 * 是否该提一份自改（影子）提案。
 * @returns {{should:boolean, spot?:object, reason?:string, blocked?:string}}
 */
export function shouldPropose({ events = [], lastByTarget = {}, now = Date.now() } = {}) {
  const spots = findWeakSpots(events, { now });
  if (!spots.length) return { should: false, reason: "没有够多的失败证据" };
  for (const spot of spots) {
    if (now - (lastByTarget[spot.key] || 0) < COOLDOWN_MS) continue;
    return { should: true, spot, reason: `${spot.key} 近 72 小时失败 ${spot.fails} 次` };
  }
  return { should: false, reason: "都在冷却中" };
}

/** 生成影子提案（带 shadow 标记，不含分支与文件）。 */
export function makeShadowProposal(spot, { now = Date.now(), reason = "" } = {}) {
  return {
    id: `shadow_${now.toString(36)}`,
    at: new Date(now).toISOString(),
    shadow: true,
    enabled: false,
    target: spot.target,
    targetId: spot.targetId,
    fails: spot.fails,
    taskTypes: spot.taskTypes,
    reason: reason || `${spot.targetId} 近 72 小时失败 ${spot.fails} 次`,
    hypothesis: "待定：需要先定位失败发生在哪一步（规划/编码/验证）",
    next: "确认要改之后，用 POST /api/selfchange/validate 提交文件列表走自证链",
    rollback: "影子提案不产生任何改动，删除台账记录即可",
  };
}
