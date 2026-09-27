// engine/sse.mjs —— SSE 流式响应工具（2026-08-20 从 server.mjs 拆出：sseWrite/createSseWriter/startSseHeartbeat）
// 纯函数：只依赖 node res 对象，无外部状态

export function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// SSE 写入器（带背压控制，对标 pi EventStream queue 思想）
// 问题：res.write 在内核缓冲满时返回 false，直接硬写会堆积内存（公网慢网络长回复）
// 方案：检测返回值 → 进入 draining 模式，后续事件入队，等 drain 事件再按序 flush
// 与 EventStream 一致：生产者 push 永不阻塞、事件不丢，消费速度由内核 drain 节流
export function createSseWriter(res) {
  const pending = [];
  let draining = false;
  let closed = false;
  let waitResolve = null;

  function drain() {
    draining = false;
    while (pending.length && !closed) {
      const chunk = pending.shift(); // 先出队：write 返回 false 时数据也已进入内核缓冲（Node 语义，不丢）
      let ok = true;
      try { ok = res.write(chunk); } catch { closed = true; break; }
      if (!ok) {
        // 内核缓冲已满 → 暂停写，等 drain 事件再继续（防止内存堆积）
        draining = true;
        res.once("drain", drain);
        break;
      }
    }
    if (waitResolve && !pending.length && !draining) {
      const r = waitResolve; waitResolve = null; r();
    }
  }

  return {
    push(event, data) {
      if (closed) return;
      const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (draining) { pending.push(chunk); return; }
      let ok = true;
      try { ok = res.write(chunk); } catch { closed = true; return; }
      if (!ok) { draining = true; res.once("drain", drain); }
    },
    // 等待所有已入队事件写完（供 finally 收尾时确保 flush 完再 res.end）
    async flush() {
      if (!pending.length && !draining) return;
      if (pending.length && draining) {
        await new Promise(r => { waitResolve = r; });
      }
    },
    close() { closed = true; pending.length = 0; },
  };
}

// SSE 心跳（长连接保活，避免公网代理/超时掐断）
export function startSseHeartbeat(res) {
  const hb = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, 20000);
  return hb;
}
