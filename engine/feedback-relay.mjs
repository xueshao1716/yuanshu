// 按原路地址把回信发回去（2026-10-26）
//
// 用户要求：「按原路地址给说回去」——报告从哪来，回信就往哪发。
// 现实约束：公网反馈端点我们没有控制权，能不能收 reply 未知。
// 所以这里做 best-effort：有 replyTo 才发；发不出去只在本地记 relayError，
// 绝不因为回信失败而丢掉"我说过什么"。
export const RELAY_TIMEOUT_MS = 8000;

/**
 * @param {{replyTo:string, threadId?:string, itemId:string}} target
 * @param {{kind:string, text:string, by?:string}} reply
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
export async function relayReply(target = {}, reply = {}, { fetch: f = globalThis.fetch, timeoutMs = RELAY_TIMEOUT_MS } = {}) {
  const url = String(target.replyTo || "").trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "no_reply_address" };
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        type: "reply",
        threadId: target.threadId || "",
        itemId: target.itemId || "",
        kind: reply.kind || "triage",
        by: reply.by || "元枢",
        text: String(reply.text || "").slice(0, 4000),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}` };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}
