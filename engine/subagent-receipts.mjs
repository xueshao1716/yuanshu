// engine/subagent-receipts.mjs —— 后台子代理的回传落点（2026-11-07）
//
// 一条闭环里最容易断的一段是"跑完了，但没人知道"。这里把它固定成三个动作：
//   ① postSubagentReceipt：终态（done/failed/cancelled/interrupted）写进 agent-mailbox，
//      to = 父会话/父 agent，from = `subagent:<id>`（收件一侧据此认出"这是子代理回执"）。
//   ② listUnreadSubagentReceipts / subagentUnreadCount：父会话还有几条没看的回执。
//   ③ deliverSubagentReceipts：下一轮开场时把未读回执拼成 `【系统】子代理 X 已完成：…（未读 N 条）`，
//      注入完立刻标已读——否则同一条会在每一轮反复占上下文（与 media 的【系统】注入同一个道理）。
//
// 只碰 mailbox，不碰执行、不碰 traces，方便单独测。
import { postMessage, inboxFor, markRead, readMailbox } from "./agent-mailbox.mjs";
import { buildReceiptNote, statusLabel } from "./subagent-state.mjs";

export const SUBAGENT_SENDER_PREFIX = "subagent:";
const MAX_NOTE_ITEMS = 3;

/** 从 mailbox 消息的 from 里取 subagentId（不是子代理回执就返回空串）。 */
export function senderSubagentId(message) {
  const from = String(message?.from || "");
  return from.startsWith(SUBAGENT_SENDER_PREFIX) ? from.slice(SUBAGENT_SENDER_PREFIX.length) : "";
}

/** 这条回执该发给谁：优先父会话 id，其次父 agent 名，最后兜底到默认人格。 */
export function parentTargetOf(record = {}) {
  return String(record.parentSessionId || record.parentAgent || "小语").slice(0, 40);
}

/**
 * 把一条回执写进留言板。
 * @param {{wsRoot:string, record:object, receipt:{text:string,kind:string,status:string,summary:string}, at?:number}} p
 * @returns {{ok:boolean, id?:string, error?:string}}
 */
export function postSubagentReceipt({ wsRoot, record = {}, receipt = {}, at = Date.now() } = {}) {
  const id = String(record.id || "");
  if (!id) return { ok: false, error: "记录缺少 id" };
  const out = postMessage({
    wsRoot,
    from: `${SUBAGENT_SENDER_PREFIX}${id}`,
    to: parentTargetOf(record),
    text: receipt.text || `【子代理回执】${id} ${statusLabel(record.status)}`,
    kind: receipt.kind || "note",
    at,
    // 结构化附注：注入文案不必回头解析正文，界面上也能直接认出是哪条子代理
    meta: {
      subagentId: id,
      status: String(record.status || ""),
      statusLabel: statusLabel(record.status, { errorCode: record.errorCode }),
      summary: String(receipt.summary || "").slice(0, 200),
      durationMs: Number(record.durationMs) || 0,
      continueCount: Number(record.continueCount) || 0,
    },
  });
  return out.ok ? { ok: true, id: out.message.id } : { ok: false, error: out.error };
}

/** 某个 agent（这里就是父会话 id）的未读子代理回执，最新在前。 */
export function listUnreadSubagentReceipts(wsRoot, agent, { limit = 20 } = {}) {
  const who = String(agent || "").trim();
  if (!who) return [];
  return inboxFor(wsRoot, who, { limit: 999, unreadOnly: true })
    .filter((message) => !!senderSubagentId(message))
    .slice(0, Math.max(1, Number(limit) || 20))
    .map((message) => ({
      messageId: message.id,
      subagentId: senderSubagentId(message),
      from: message.from,
      to: message.to,
      kind: message.kind,
      at: Number(message.at) || 0,
      text: String(message.text || ""),
      status: String(message.meta?.status || ""),
      statusLabel: String(message.meta?.statusLabel || statusLabel(message.meta?.status)),
      summary: String(message.meta?.summary || ""),
    }));
}

/** 父会话还有几条子代理回执没看。 */
export function subagentUnreadCount(wsRoot, agent) {
  return listUnreadSubagentReceipts(wsRoot, agent, { limit: 999 }).length;
}

/**
 * 某条子代理的回执还有几条没人读（列表接口用：没有"我是谁"的上下文，
 * 所以按"任何人读过就不再算未读"来算）。
 */
export function unreadOfSubagent(wsRoot, subagentId) {
  const id = String(subagentId || "");
  if (!id) return 0;
  return (readMailbox(wsRoot).items || [])
    .filter((message) => senderSubagentId(message) === id)
    .filter((message) => !(Array.isArray(message.readBy) ? message.readBy : []).length)
    .length;
}

/** 一次读盘算出"每条子代理各有几条未读"，给列表接口用（别按记录数反复读文件）。 */
export function unreadBySubagent(wsRoot) {
  const counts = new Map();
  for (const message of readMailbox(wsRoot).items || []) {
    const id = senderSubagentId(message);
    if (!id) continue;
    if ((Array.isArray(message.readBy) ? message.readBy : []).length) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

/**
 * 下一轮注入用：取父会话的未读回执 → 拼成一条系统提示 → 标记已读。
 * 没有未读时返回空串（调用方据此决定要不要注入，避免每轮都塞一句废话）。
 * @returns {{text:string, count:number, unread:number, ids:string[]}}
 */
export function deliverSubagentReceipts({ wsRoot, agent, limit = MAX_NOTE_ITEMS } = {}) {
  const empty = { text: "", count: 0, unread: 0, ids: [] };
  const rows = listUnreadSubagentReceipts(wsRoot, agent, { limit });
  if (!rows.length) return empty;
  const unread = subagentUnreadCount(wsRoot, agent);
  const items = rows.map((row) => ({
    id: row.subagentId,
    status: row.status,
    statusLabel: row.statusLabel,
    summary: row.summary || row.text,
  }));
  const text = buildReceiptNote(items, unread);
  if (!text) return empty;
  // 注入即消费：同一条回执只在"它出现的那一轮"占上下文，之后靠 /api/subagent/list 查。
  try { markRead({ wsRoot, agent, ids: rows.map((row) => row.messageId) }); } catch { /* 已读失败不影响注入 */ }
  return { text, count: items.length, unread, ids: items.map((item) => item.id) };
}
