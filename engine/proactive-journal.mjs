// ===== proactive-journal.mjs —— 主动推送台账（2026-11-09）=====
//
// 为什么和策略层分开：proactive-policy.mjs 要"纯函数、无 I/O"（否则每条判定都没法在测试里复现），
// 落盘的活全放这里。一行一条已经发出去的主动推送：
//   {at, atIso, trigger, priority, urgency, topic, text, textId, channel, kind, replied}
//
// 两个用途：
//   ① decide 读它做"连续 3 条没回复暂停"与 per-topic 冷却（state.recent = readOutreach(...)）；
//   ② 事后统计：哪类触发、哪句话术被回过（textId 就是为此留的）。
//
// 「有回复」怎么判：不假装精确。用户在元枢里有任何动作（发消息 / 开任务 / 点推送反应），
// 就把还挂着的推送标成 replied —— 和 notice-reactions.mjs 的 markRecentActivity 同一套近似。
import fs from "node:fs";
import path from "node:path";
import { consecutiveNoReply } from "./proactive-policy.mjs";

export const OUTREACH_REL = path.join("记忆", "运行时", "主动推送.jsonl");
export const MAX_ROWS = 300;

export function outreachFile(wsRoot) {
  return path.join(String(wsRoot || "."), OUTREACH_REL);
}

/** 记一条推送。返回写入的行（调用方要把它塞回 state.recent 继续判）。 */
export function recordOutreach(wsRoot, {
  at = Date.now(), trigger = "", priority = 0, urgency = "low", topic = "",
  text = "", textId = "", channel = "notify", kind = "", replied = false,
} = {}) {
  const t = Number(at);
  const ts = Number.isFinite(t) ? t : Date.now();
  const row = {
    at: ts,
    atIso: new Date(ts).toISOString(),
    trigger: String(trigger || ""),
    priority: Number(priority) || 0,
    urgency: String(urgency || "low"),
    topic: String(topic || trigger || ""),
    text: String(text || "").slice(0, 300),
    textId: String(textId || ""),
    channel: String(channel || "notify"),
    kind: String(kind || ""),
    replied: replied === true,
  };
  try {
    fs.mkdirSync(path.dirname(outreachFile(wsRoot)), { recursive: true });
    fs.appendFileSync(outreachFile(wsRoot), JSON.stringify(row) + "\n", "utf8");
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 读台账（时间正序，只留最近 limit 条）。坏行跳过，不因为一行坏掉整个判定。 */
export function readOutreach(wsRoot, { limit = MAX_ROWS } = {}) {
  try {
    const rows = fs.readFileSync(outreachFile(wsRoot), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((r) => r && typeof r === "object" && Number.isFinite(Number(r.at)))
      .map((r) => ({ ...r, at: Number(r.at) }));
    rows.sort((a, b) => a.at - b.at);
    return limit > 0 ? rows.slice(-limit) : rows;
  } catch {
    return [];
  }
}

function writeOutreach(wsRoot, rows = []) {
  const p = outreachFile(wsRoot);
  const tail = rows.slice(-MAX_ROWS);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, tail.map((r) => JSON.stringify(r)).join("\n") + (tail.length ? "\n" : ""), "utf8");
  return tail;
}

/**
 * 用户有动作了：把还挂着的推送标成已回复（近似，不假装知道回的是哪一条）。
 * 这是"连续 3 条没回复暂停"的恢复开关——不接它，暂停就是永久静音。
 */
export function markOutreachReplied(wsRoot, { now = Date.now(), onlyWithinMs = 0 } = {}) {
  const rows = readOutreach(wsRoot);
  const t = Number(now);
  let marked = 0;
  for (const r of rows) {
    if (r.replied === true) continue;
    if (onlyWithinMs > 0 && t - r.at > onlyWithinMs) continue;
    r.replied = true;
    r.repliedAt = t;
    marked += 1;
  }
  if (marked) {
    try { writeOutreach(wsRoot, rows); } catch { /* 写不了就算了，下次动作再标 */ }
  }
  return { ok: true, marked };
}

/** 当前连着几条没回复（给面板/日志用）。 */
export function outreachStreak(wsRoot) {
  return consecutiveNoReply(readOutreach(wsRoot));
}

/** 按 trigger 统计：发了多少、回过多少。 */
export function outreachStats(wsRoot, { days = 14, now = Date.now() } = {}) {
  const since = Number(now) - Number(days) * 86400000;
  const rows = readOutreach(wsRoot).filter((r) => r.at >= since);
  const by = new Map();
  for (const r of rows) {
    const k = String(r.trigger || "unknown");
    const cur = by.get(k) || { trigger: k, sent: 0, replied: 0 };
    cur.sent += 1;
    if (r.replied === true) cur.replied += 1;
    by.set(k, cur);
  }
  return [...by.values()]
    .map((x) => ({ ...x, replyRate: x.sent ? Number((x.replied / x.sent).toFixed(2)) : null }))
    .sort((a, b) => b.sent - a.sent);
}
