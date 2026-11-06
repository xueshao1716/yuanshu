// ===== engine/memory/forget.mjs —— 遗忘（2026-11-06）=====
//
// 只归档、不删除。归档的东西仍然能被召回（status='archived' 里查得到），
// 但不再占用"常用记忆"的位置。这就是"遗忘长时间不翻的账"。
import { listMemories, updateMemory, sweepExpired as sweepByExpire } from "./db.mjs";

export const FORGET_RULES = {
  staleDays: 90,        // 90 天没被访问
  lowImportance: 0.45,  // 且重要性低于这个值
  neverAccessedDays: 30 // 创建 30 天一次都没用过
};

/** 判断一条记忆该不该归档；返回原因或 null。 */
export function shouldForget(row, now = Date.now(), rules = FORGET_RULES) {
  if (!row || row.status !== "active") return null;
  const day = 86400000;
  const last = Number(row.last_accessed_at || 0);
  const created = Number(row.created_at || 0);
  const imp = Number(row.importance_score ?? 0.5);
  if (last && now - last > rules.staleDays * day && imp < rules.lowImportance) return "stale";
  if (!last && created && now - created > rules.neverAccessedDays * day && imp < rules.lowImportance) return "never_accessed";
  if (Number.isFinite(Number(row.expire_at)) && Number(row.expire_at) > 0 && Number(row.expire_at) < now) return "expired";
  return null;
}

/**
 * 跑一次遗忘。只归档，不删。
 * @returns {{ archived: number, byReason: object, items: Array }}
 */
export function forgetStale({ now = Date.now(), rules = FORGET_RULES, dryRun = false } = {}) {
  const rows = (listMemories({ status: "active", limit: 2000 })?.items) || [];
  const out = { archived: 0, byReason: {}, items: [] };
  for (const row of rows) {
    const reason = shouldForget(row, now, rules);
    if (!reason) continue;
    out.byReason[reason] = (out.byReason[reason] || 0) + 1;
    out.items.push({ id: row.memory_id, reason, summary: String(row.summary || "").slice(0, 60) });
    if (dryRun) { out.archived += 1; continue }
    try { updateMemory(row.memory_id, { status: "archived" }); out.archived += 1 } catch {}
  }
  return out;
}

/** 过期清理（库里已有 expire_at 机制）+ 遗忘规则，一次跑完。 */
export function runForgetCycle({ now = Date.now(), dryRun = false } = {}) {
  const expired = dryRun ? { archived: 0 } : sweepByExpire();
  const stale = forgetStale({ now, dryRun });
  return {
    expiredArchived: expired.archived || 0,
    staleArchived: stale.archived,
    byReason: stale.byReason,
    items: stale.items.slice(0, 20),
  };
}
