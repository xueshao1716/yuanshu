// ===== thread-relay.mjs —— 直通之后的回话通道（2026-11-07）=====
//
// 直通把同一个话题的后续事件收进收件箱，下一轮合并处理。问题在后半段：
// **结果回哪儿**。原文的做法是「Worker 不直接对外说话，由 Router 统一回复」——
// 元枢这边对应的是 relay：谁问的，结果就回给谁，而且只回一次。
//
// 这一层只做三件事：话题键 → 回哪条通道、正文怎么裁、按注入的发送器发出去。
// 真正的发送（微信 sendTo / 邮件 send）由 server 注入，便于测试与降级。
const CHANNEL_OF_PREFIX = Object.freeze({ wechat: "wechat", mail: "mail" });

/** 话题键 → 回话目标。认不出通道返回 channel:""，调用方据此走原来的通知。 */
export function relayTargetOf(threadKey = "") {
  const key = String(threadKey || "");
  const i = key.indexOf(":");
  if (i <= 0) return { channel: "", to: "" };
  const prefix = key.slice(0, i);
  const channel = CHANNEL_OF_PREFIX[prefix] || "";
  return { channel, to: channel ? key.slice(i + 1) : "" };
}

/**
 * 回话正文：IM 里贴长文没人看，裁到 limit 字，保留「是什么 + 结论 + 下一步」。
 * 空结果返回空串（调用方据此不发）。
 */
export function composeRelayText(text = "", { limit = 600, head = "" } = {}) {
  const body = String(text || "").replace(/\r/g, "").trim();
  if (!body) return "";
  const prefix = String(head || "").trim();
  const room = Math.max(80, limit - (prefix ? prefix.length + 1 : 0));
  const cut = body.length > room ? `${body.slice(0, room - 1)}…` : body;
  return prefix ? `${prefix}\n${cut}` : cut;
}

/**
 * 把结果 relay 回话题原来的地方。
 * @param {{threadKey:string, text:string, head?:string, limit?:number,
 *          send:(msg:{channel:string,to:string,body:string})=>Promise<{ok:boolean,detail?:string}>}} p
 * @returns {Promise<{ok:boolean, channel:string, to:string, body:string, detail:string, skipped?:string}>}
 */
export async function relayToThread({ threadKey = "", text = "", head = "", limit = 600, send = null } = {}) {
  const target = relayTargetOf(threadKey);
  if (!target.channel) return { ok: false, channel: "", to: "", body: "", detail: "这个话题没有回话通道", skipped: "no_channel" };
  const body = composeRelayText(text, { limit, head });
  if (!body) return { ok: false, channel: target.channel, to: target.to, body: "", detail: "没有可回的内容", skipped: "empty" };
  if (typeof send !== "function") return { ok: false, channel: target.channel, to: target.to, body, detail: "没有接入发送器", skipped: "no_sender" };
  try {
    const r = await send({ channel: target.channel, to: target.to, body });
    return { ok: !!r?.ok, channel: target.channel, to: target.to, body, detail: String(r?.detail || (r?.ok ? "已回复" : "发送失败")) };
  } catch (e) {
    return { ok: false, channel: target.channel, to: target.to, body, detail: String(e?.message || e).slice(0, 160) };
  }
}
