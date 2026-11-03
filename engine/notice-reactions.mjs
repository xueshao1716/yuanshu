// ===== notice-reactions.mjs —— 推送反应台账（2026-11-03）=====
//
// 目的：推送发出去之后要能回收信号（Adaptation）。没有这一步，"主动"就是在猜。
// 记录：每条推送一个 key（kind+对象+时间），反应只有 open / ignore / reply。
// 规则：同一类推送连续 N 条无反应 → 降频（shouldThrottle）。
import fs from "node:fs";
import path from "node:path";

export const REACT_REL = path.join("记忆", "运行时", "推送反应.jsonl");
const file = (wsRoot) => path.join(String(wsRoot || "."), REACT_REL);

function append(wsRoot, row) {
  try {
    fs.mkdirSync(path.dirname(file(wsRoot)), { recursive: true });
    fs.appendFileSync(file(wsRoot), JSON.stringify(row) + "\n", "utf8");
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

export function recordPush(wsRoot, { key, kind = "generic", at = new Date().toISOString() } = {}) {
  if (!key) return { ok: false, error: "缺 key" };
  return append(wsRoot, { type: "push", key: String(key), kind: String(kind), at });
}

export function recordReaction(wsRoot, { key, action = "ignore", at = new Date().toISOString() } = {}) {
  if (!key) return { ok: false, error: "缺 key" };
  if (!["open", "ignore", "reply"].includes(action)) return { ok: false, error: `未知反应：${action}` };
  return append(wsRoot, { type: "reaction", key: String(key), action, at });
}

export function readReactions(wsRoot) {
  try {
    return fs.readFileSync(file(wsRoot), "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  } catch { return [] }
}

/** 按类型统计：发了多少、被看了多少、被忽略多少。 */
export function reactionStats(wsRoot, { days = 14, now = Date.now() } = {}) {
  const since = now - days * 86400000;
  const rows = readReactions(wsRoot).filter((r) => {
    const t = Date.parse(String(r.at || ""));
    return !Number.isFinite(t) || t >= since;
  });
  const pushes = rows.filter((r) => r.type === "push");
  const reacts = new Map(rows.filter((r) => r.type === "reaction").map((r) => [r.key, r.action]));
  const by = new Map();
  for (const p of pushes) {
    const row = by.get(p.kind) || { kind: p.kind, sent: 0, opened: 0, ignored: 0, replied: 0, pending: 0 };
    row.sent += 1;
    const a = reacts.get(p.key);
    if (a === "open") row.opened += 1;
    else if (a === "reply") row.replied += 1;
    else if (a === "ignore") row.ignored += 1;
    else row.pending += 1;
    by.set(p.kind, row);
  }
  return [...by.values()].map((r) => ({
    ...r,
    ignoreRate: r.sent ? Number(((r.ignored + r.pending) / r.sent).toFixed(2)) : null,
    engageRate: r.sent ? Number(((r.opened + r.replied) / r.sent).toFixed(2)) : null,
  })).sort((a, b) => b.sent - a.sent);
}

/** 同一类连续 N 条没反应 → 建议降频。 */
export function shouldThrottle(wsRoot, kind, { threshold = 3 } = {}) {
  const rows = readReactions(wsRoot);
  const reacts = new Set(rows.filter((r) => r.type === "reaction" && ["open", "reply"].includes(r.action)).map((r) => r.key));
  const pushes = rows.filter((r) => r.type === "push" && r.kind === kind).slice(-threshold);
  if (pushes.length < threshold) return { throttle: false, reason: "样本不足" };
  const engaged = pushes.filter((p) => reacts.has(p.key)).length;
  return engaged === 0
    ? { throttle: true, reason: `最近 ${threshold} 条「${kind}」你都没看，建议降频` }
    : { throttle: false, reason: "有互动" };
}


/** 最近 window 内还没反应的推送（按时间倒序）。 */
export function pendingPushes(wsRoot, { withinMs = 2 * 3600 * 1000, now = Date.now() } = {}) {
  const rows = readReactions(wsRoot);
  const reacted = new Set(rows.filter((r) => r.type === "reaction").map((r) => r.key));
  return rows
    .filter((r) => r.type === "push" && !reacted.has(r.key))
    .filter((r) => now - (Date.parse(String(r.at || "")) || 0) <= withinMs)
    .reverse();
}

/** 用户有任何动作时调用：把窗口内未反应的推送标成 open（行为近似，不假装精确）。 */
export function markRecentActivity(wsRoot, { action = "open", withinMs = 2 * 3600 * 1000, now = Date.now() } = {}) {
  const list = pendingPushes(wsRoot, { withinMs, now });
  let n = 0;
  for (const p of list) { if (recordReaction(wsRoot, { key: p.key, action, at: new Date(now).toISOString() }).ok) n += 1 }
  return { ok: true, marked: n };
}
