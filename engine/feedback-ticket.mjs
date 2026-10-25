// ===== feedback-ticket.mjs —— 让每份反馈都能"对上号"（2026-10-26）=====
//
// 用户要求：「按原路地址给说回去…最后修好了再回一次」。要能回信，前提是两边认得出是同一件事。
// 公网端点不一定给回信地址，但**工单号**我们自己能造、能带、能在回信里引用。
//
//   installId —— 同一台机器稳定不变（换机器才变），用来把多份报告归到一台设备
//   ticketId  —— 每次提交一个新的，回信里原样引用，双方靠它对号
//   replyTo   —— 可选：提交方如果有可访问的回信地址就填（分布式安装多数在 NAT 后面，通常留空）
//
// 落盘：`记忆/运行时/反馈工单.json`（只存 installId + 序号，不存内容）
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const TICKET_FILE = path.join("记忆", "运行时", "反馈工单.json");

function fileOf(wsRoot) { return path.join(String(wsRoot || "."), TICKET_FILE); }

function readState(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch {}
  return null;
}

function writeState(wsRoot, state) {
  const file = fileOf(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  return state;
}

/** 取（或首次生成）本机装机的 installId。 */
export function installIdentity(wsRoot, { now = Date.now() } = {}) {
  const cur = readState(wsRoot);
  if (cur?.installId) return cur;
  const state = { installId: randomUUID(), createdAt: now, seq: 0, lastTicket: null };
  return writeState(wsRoot, state);
}

/** 造一个新工单号（可读、带日期、递增）。 */
export function newTicket(wsRoot, { now = Date.now() } = {}) {
  const state = installIdentity(wsRoot, { now });
  const seq = (Number(state.seq) || 0) + 1;
  const d = new Date(now);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const ticketId = `T-${stamp}-${String(seq).padStart(4, "0")}`;
  const next = writeState(wsRoot, { ...state, seq, lastTicket: ticketId, lastTicketAt: now });
  return { ticketId, installId: next.installId, seq };
}

/**
 * 把工单信息并进提交体（不覆盖调用方已有的值）。
 * @param {object} payload 原有 payload
 * @param {{ticketId?:string, installId:string, replyTo?:string}} ticket
 */
export function withTicket(payload = {}, ticket = {}) {
  const out = { ...payload };
  if (!out.ticketId && ticket.ticketId) out.ticketId = ticket.ticketId;
  if (!out.installId && ticket.installId) out.installId = ticket.installId;
  if (!out.replyTo && ticket.replyTo) out.replyTo = ticket.replyTo;
  return out;
}

/** 回信时附在末尾的一行：让双方都能靠工单号对上。 */
export function ticketLine({ ticketId = "", installId = "" } = {}) {
  if (!ticketId && !installId) return "";
  const parts = [];
  if (ticketId) parts.push(`工单 ${ticketId}`);
  if (installId) parts.push(`设备 ${String(installId).slice(0, 8)}`);
  return `（${parts.join(" · ")}——回信时带上这个号，我们就能对上你报的是哪一条）`;
}
