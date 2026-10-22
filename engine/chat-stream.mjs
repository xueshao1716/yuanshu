// engine/chat-stream.mjs —— 聊天流：执行脱离 HTTP，刷新/断线不取消（2026-10-23）
//
// 问题：聊天执行绑在 HTTP 请求上，`req.on('close')` 就 abort → 刷新页面=取消任务。
// 做法（最小闭环）：
//   · 每轮对话一个 stream（按会话归并），每个 SSE 片段带 `id: seq` 存环形缓冲；
//   · 客户端断开只 detach，**不 abort**；显式停止 / 新轮次顶替才 abort；
//   · GET /api/chat/stream?session=<id>&after=<seq> 可重连补发，然后继续接实时流。
// 不落盘：进程重启后缓冲丢失，重连得到 running:false —— 前端据此提示"上一轮已中断"，不假装还在跑。
const MAX_EVENTS = 4000;
const MAX_BYTES = 4 * 1024 * 1024;

export function createChatStreamHub() {
  const streams = new Map();

  function create(key) {
    const events = [];
    let bytes = 0;
    let seq = 0;
    let res = null;
    let closed = false;
    const controller = new AbortController();
    const listeners = new Set();

    const trim = () => {
      while (events.length > MAX_EVENTS || bytes > MAX_BYTES) {
        const dropped = events.shift();
        if (!dropped) break;
        bytes -= dropped.size;
      }
    };
    const writeRaw = (target, chunk) => { try { if (target && !target.writableEnded) target.write(chunk) } catch {} };

    const stream = {
      key,
      get seq() { return seq },
      get done() { return closed },
      signal: controller.signal,
      /** 送一个 SSE 片段进流（自动编号、缓冲、转发） */
      feed(chunk) {
        if (closed) return;
        const text = String(chunk);
        if (!text) return;
        const size = Buffer.byteLength(text);
        seq += 1;
        const item = { seq, payload: `id: ${seq}\n${text}`, size };
        events.push(item);
        bytes += size;
        trim();
        for (const l of listeners) { try { l(item) } catch {} }
        writeRaw(res, item.payload);
      },
      attach(resRef, after = 0) {
        res = resRef;
        try {
          resRef.writeHead?.(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
        } catch {}
        for (const e of events) if (e.seq > after) writeRaw(resRef, e.payload);
        return { seq, done: closed };
      },
      detach(resRef) { if (res && (!resRef || res === resRef)) res = null },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      /** 正常收尾：补一条 done 再断开 */
      finish() {
        if (closed) return;
        closed = true;
        seq += 1;
        const tail = `id: ${seq}\nevent: done\ndata: {"ok":true}\n\n`;
        events.push({ seq, payload: tail, size: Buffer.byteLength(tail) });
        for (const l of listeners) { try { l({ seq, payload: tail }) } catch {} }
        writeRaw(res, tail);
        try { res?.end() } catch {}
        res = null;
        streams.delete(key);
      },
      abort(reason = 'aborted') {
        if (!controller.signal.aborted) controller.abort({ code: reason });
      },
      /** 让 handleUnifiedChat 那种直接写 res 的代码走同一个流 */
      wrapResponse(nativeRes) {
        const wrapper = {
          get writableEnded() { return closed },
          headersSent: true,
          setHeader() {}, writeHead() { return wrapper }, flushHeaders() {},
          write(chunk) { stream.feed(chunk); return true },
          end() { stream.finish(); try { nativeRes?.end() } catch {} },
          on() { return wrapper }, once() { return wrapper }, removeListener() { return wrapper },
        };
        return wrapper;
      },
    };
    streams.set(key, stream);
    return stream;
  }

  return {
    create,
    get: (key) => streams.get(key) || null,
    has: (key) => streams.has(key),
    list: () => [...streams.keys()],
    abort: (key, reason) => streams.get(key)?.abort(reason),
    size: () => streams.size,
    summary: () => [...streams.values()].map((s) => ({ key: s.key, seq: s.seq, done: s.done })),
  };
}
