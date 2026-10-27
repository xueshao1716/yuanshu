// ===== agent-mailbox.mjs —— agent 之间的留言（2026-10-27）=====
//
// Agensh 的第二件套「消息接口」：
//   · 组织级消息（谁都能看到）
//   · 1:1 消息（问一句、答一句）
// 元枢原来的接口台只管「人 ↔ 系统」；这里补的是「agent ↔ agent」。
//
// 刻意做得像留言板而不是聊天室：写完就落盘，读的人自己来取，不追求实时。
import fs from "node:fs";
import path from "node:path";

export const MSG_REL = path.join("记忆", "运行时", "agent消息.json");
export const MAX_MESSAGES = 300;
export const KINDS = ["note", "question", "answer", "alert"];

const fileOf = (ws) => path.join(String(ws || "."), MSG_REL);

export function readMailbox(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), "utf8"));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch {}
  return { v: 1, items: [] };
}

function writeMailbox(wsRoot, data) {
  fs.mkdirSync(path.dirname(fileOf(wsRoot)), { recursive: true });
  fs.writeFileSync(fileOf(wsRoot), JSON.stringify({ ...data, v: 1, updatedAt: Date.now() }, null, 2), "utf8");
}

/**
 * 留一条言。
 * @param {{wsRoot:string, from:string, to?:string, text:string, kind?:string, replyTo?:string, at?:number}} p
 */
export function postMessage({ wsRoot, from = "小语", to = "", text = "", kind = "note", replyTo = "", at = Date.now() } = {}) {
  const body = String(text || "").trim().slice(0, 2000);
  if (!body) return { ok: false, error: "text 不能为空" };
  const who = String(from || "小语").slice(0, 40);
  const target = String(to || "").slice(0, 40);   // 空 = 广播
  const k = KINDS.includes(kind) ? kind : "note";
  const msg = {
    id: `m-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at, from: who, to: target, kind: k, text: body,
    replyTo: String(replyTo || "") || undefined,
    readBy: [],
  };
  const data = readMailbox(wsRoot);
  data.items = [msg, ...(data.items || [])].slice(0, MAX_MESSAGES);
  writeMailbox(wsRoot, data);
  return { ok: true, message: msg };
}

/** 某个 agent 该看到的：发给它的 + 广播（自己发的不算）。 */
export function inboxFor(wsRoot, agent, { limit = 20, unreadOnly = false } = {}) {
  const who = String(agent || "小语");
  return (readMailbox(wsRoot).items || [])
    .filter((m) => m.from !== who)
    .filter((m) => !m.to || m.to === who)
    .filter((m) => !unreadOnly || !(m.readBy || []).includes(who))
    .slice(0, Math.max(1, limit));
}

export function markRead({ wsRoot, agent, ids = [] } = {}) {
  const who = String(agent || "小语");
  const board = readMailbox(wsRoot);
  let n = 0;
  for (const m of board.items || []) {
    if (ids.length && !ids.includes(m.id)) continue;
    if (m.from === who) continue;
    if (m.to && m.to !== who) continue;
    const readBy = new Set(m.readBy || []);
    if (readBy.has(who)) continue;
    readBy.add(who);
    m.readBy = [...readBy];
    n += 1;
  }
  if (n) writeMailbox(wsRoot, board);
  return { ok: true, marked: n };
}

export function unreadCount(wsRoot, agent) {
  return inboxFor(wsRoot, agent, { limit: 999, unreadOnly: true }).length;
}

/** 环境事实一行：有未读才说一句。 */
export function mailboxLine(wsRoot, agent = "小语") {
  const unread = inboxFor(wsRoot, agent, { limit: 3, unreadOnly: true });
  if (!unread.length) return "";
  const head = unread.slice(0, 2).map((m) => `${m.from}：${String(m.text).slice(0, 30)}`).join("；");
  return `【同僚留言】${unread.length} 条未读：${head}——用 agent_inbox 读，读完用 agent_read 标记。`;
}

export function recentMessages(wsRoot, { limit = 20 } = {}) {
  return (readMailbox(wsRoot).items || []).slice(0, Math.max(1, limit));
}
