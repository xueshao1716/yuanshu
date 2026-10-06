// 腾讯 iLink Bot 协议客户端（微信私聊机器人）。
// 协议常量来自小语 2026-10-06 自己接通的桥（工程/ilink-weixin-bridge.mjs，参考 hermes-agent），
// 这里只管协议：扫码登录、长轮询收消息、发消息。会话、调度、落盘在 wechat-bridge.mjs。
import crypto from "node:crypto";

export const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const APP_ID = "bot";
const CHANNEL_VERSION = "2.2.0";
const CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);
export const EP = {
  qr: "ilink/bot/get_bot_qrcode",
  qrStatus: "ilink/bot/get_qrcode_status",
  updates: "ilink/bot/getupdates",
  send: "ilink/bot/sendmessage",
};
export const LONG_POLL_MS = 35_000;
export const RATE_LIMITED = -2;
const API_TIMEOUT_MS = 15_000;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const ITEM_TEXT = 1;
export const MAX_TEXT = 2000;

export function ilinkHeaders(token) {
  const h = {
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
    "X-WECHAT-UIN": crypto.randomBytes(4).toString("base64"),
  };
  if (token) { h.Authorization = `Bearer ${token}`; h.AuthorizationType = "ilink_bot_token"; }
  return h;
}

async function parse(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ret: -999, raw: text.slice(0, 200) }; }
}

export function createIlinkClient({ fetch: f = globalThis.fetch, base = ILINK_BASE } = {}) {
  const post = async (endpoint, payload, token, timeoutMs = API_TIMEOUT_MS, at = base) => parse(await f(`${at}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ilinkHeaders(token) },
    body: JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } }),
    signal: AbortSignal.timeout(timeoutMs),
  }));
  const get = async (endpoint, timeoutMs = API_TIMEOUT_MS, at = base) => parse(await f(`${at}/${endpoint}`, {
    method: "GET", headers: ilinkHeaders(null), signal: AbortSignal.timeout(timeoutMs),
  }));
  return {
    async fetchQr(at = base) {
      const r = await get(`${EP.qr}?bot_type=3`, LONG_POLL_MS, at);
      return { value: String(r.qrcode || ""), url: String(r.qrcode_img_content || "") };
    },
    qrStatus: (value, at = base) => get(`${EP.qrStatus}?qrcode=${encodeURIComponent(value)}`, LONG_POLL_MS, at),
    getUpdates: (token, cursor, at = base) => post(EP.updates, { get_updates_buf: cursor.buf || "", ack_token: cursor.ack || "" }, token, LONG_POLL_MS + 5000, at),
    async sendText(token, to, text, contextToken, at = base) {
      const msg = {
        from_user_id: "", to_user_id: to, client_id: crypto.randomUUID(),
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [{ type: ITEM_TEXT, text_item: { text: String(text).slice(0, MAX_TEXT) } }],
      };
      if (contextToken) msg.context_token = contextToken;
      return post(EP.send, { msg }, token, API_TIMEOUT_MS, at);
    },
  };
}

// getupdates 成功响应不带 ret，判据是 msgs 数组。
export const updatesOk = (r) => Array.isArray(r?.msgs) || r?.ret === 0;

// 只认真人私聊文本；群（@chatroom）和自己发的都不进对话。
export function normalizeMessage(message, selfId) {
  const sender = String(message?.from_user_id || "").trim();
  if (!sender || (selfId && sender === selfId)) return null;
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  const text = items.filter((i) => i?.type === ITEM_TEXT).map((i) => i.text_item?.text || "").join("").trim();
  return {
    sender, text,
    isGroup: sender.endsWith("@chatroom"),
    itemTypes: items.map((i) => i?.type).join(","),
    contextToken: message.context_token || "",
  };
}

// 微信单条上限 2000 字：长回复按段落切开，尽量不从句子中间断。
export function splitForWechat(text, limit = MAX_TEXT) {
  const out = [];
  let rest = String(text || "").trim();
  while (rest.length > limit) {
    const slice = rest.slice(0, limit);
    let cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"));
    if (cut < limit * 0.5) cut = Math.max(slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？"));
    if (cut < limit * 0.5) cut = limit - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}
