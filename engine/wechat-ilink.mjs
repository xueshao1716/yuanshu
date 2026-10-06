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

// 微信纯文本安全化（2026-10-06）：微信不渲染 markdown，表格/井号/星号全是符号墙。
// 发送前剥掉渲染语法，保留文字。幂等：已转换文本再过一遍不变。
export function stripMarkdownForWechat(text) {
  if (!text || typeof text !== "string") return text || "";
  let t = text;
  // 1) 代码围栏：删 ``` 行，保留内容
  t = t.replace(/```[^\n]*\n?/g, "").replace(/```/g, "");
  // 2) 表格：分隔行整行删；数据行 | a | b | → · a：b
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{2,}[^\n]*$/gm, (line) => (line.includes("|") ? "" : line));
  t = t.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row) => {
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    if (!cells.length) return "";
    return "· " + cells.join("：");
  });
  t = t.replace(/^[ \t]*\|(.+)$/gm, (_, row) => "· " + row.split("|").map((c) => c.trim()).filter(Boolean).join("："));
  // 3) 标题：删井号留文字
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  // 4) 粗体/斜体
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
  t = t.replace(/(^|[\s，。；：（「])\*([^*\n]+)\*/g, "$1$2").replace(/(^|[\s，。；：（「])_([^_\n]+)_/g, "$1$2");
  // 5) 行内代码
  t = t.replace(/`([^`]+)`/g, "$1");
  // 6) 链接 [t](u) → t（u）
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）");
  // 7) 引用符
  t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  // 8) 无序列表符号统一成 ·
  t = t.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1· ");
  // 9) 压缩 3 行以上连续空行
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
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
