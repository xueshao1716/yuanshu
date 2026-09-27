// engine/session-bus.mjs —— 会话事件总线（2026-08-29 从 server.mjs 拆出）
// 任务事件统一入缓冲 + 广播给所有订阅者（多端实时观看）。环形缓冲 500，turn_end 清空。

export function createSessionBus(deps) {
  const { json } = deps;
  const sessionBus = new Map(); // key: taskId/sessionId → { seq, events: [], subs: Set }

  function busGet(key) {
    if (!key) return null;
    if (!sessionBus.has(key)) sessionBus.set(key, { seq: 0, events: [], subs: new Set() });
    return sessionBus.get(key);
  }

  function busPush(key, type, data) {
    const b = busGet(key);
    if (!b) return null;
    const ev = { type, seq: ++b.seq, data: data || {}, ts: Date.now() };
    b.events.push(ev);
    if (b.events.length > 500) b.events.splice(0, b.events.length - 500);
    // 任务结束：清空缓冲，避免完成后订阅端重放（历史已从 /messages 拿）
    if (type === "turn_end") b.events.length = 0;
    for (const sub of b.subs) {
      try { sub.write(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`); } catch {}
    }
    return ev;
  }

  // GET /api/sessions/:id/stream —— 会话实时订阅：补发 after 之后历史 + 实时广播 + 心跳
  async function handleSessionStream(res, req, url, id) {
    const key = decodeURIComponent(id || "");
    if (!key) return json(res, 400, { error: "缺少会话 ID" });
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const b = busGet(key);
    const after = parseInt(url?.searchParams?.get("after") || "0", 10) || 0;
    for (const ev of b.events) if (ev.seq > after) {
      try { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); } catch {}
    }
    try { res.write(`event: subscribed\ndata: ${JSON.stringify({ key, lastSeq: b.seq })}\n\n`); } catch {}
    const sub = { write: (s) => { if (!res.writableEnded) { try { res.write(s); } catch {} } } };
    b.subs.add(sub);
    const hb = setInterval(() => { try { sub.write(": ping\n\n"); } catch {} }, 20000);
    req.on("close", () => { clearInterval(hb); b.subs.delete(sub); });
  }

  return { busGet, busPush, handleSessionStream };
}
