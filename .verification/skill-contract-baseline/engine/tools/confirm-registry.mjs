// engine/tools/confirm-registry.mjs —— 危险操作确认的"等待人工回答"注册表
// 每个 pending 确认存一个 Promise（ask 用它 await），前端回传时 resolve。
// 容错：注册时可设超时（默认 60s）；超时/会话结束未答 → 按 'cancelled'（fail-closed 由调用方处理）。
// 一次注册对应一次工具调用的审批（对标 dsh allowed-once 一次性）。

const pending = new Map(); // key: `${sessionId}:${id}` → { payload, resolve, setTimeout }

const DEFAULT_TIMEOUT_MS = 60_000;

function key(sessionId, id) { return `${sessionId}:${id}`; }

function register(sessionId, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const id = payload.id || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const k = key(sessionId, id);
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  const timer = setTimeout(() => {
    if (pending.has(k)) { pending.delete(k); resolve("cancelled"); } // 超时 → cancelled（fail-closed）
  }, timeoutMs);
  // 不阻止进程退出
  if (timer.unref) timer.unref();
  pending.set(k, { payload: { ...payload, id }, resolve, timer });
  return { id, promise, sessionId, key: k };
}

// 回传：前端调 /api/agent/confirm （ok=true 放行 / ok=false 拒绝）
function settle(sessionId, id, ok) {
  const k = key(sessionId, id);
  const entry = pending.get(k);
  if (!entry) return { ok: false, error: "确认不存在或已过期" };
  pending.delete(k);
  clearTimeout(entry.timer);
  entry.resolve(ok ? "allowed-once" : "rejected");
  return { ok: true, outcome: ok ? "allowed-once" : "rejected" };
}

// 会话结束时清理该会话所有未决确认（避免泄漏/误答下轮）
function cancelAll(sessionId) {
  let n = 0;
  for (const [k, entry] of pending) {
    if (k.startsWith(`${sessionId}:`)) { pending.delete(k); clearTimeout(entry.timer); entry.resolve("cancelled"); n++; }
  }
  return n;
}

// 探测：某会话当前是否有待确认（前端 UI 展示/防重）
function hasPending(sessionId) {
  for (const [k] of pending) if (k.startsWith(`${sessionId}:`)) return true;
  return false;
}

function list() {
  return [...pending.entries()].map(([k, v]) => ({ key: k, ...v.payload }));
}

export { register, settle, cancelAll, hasPending, list, DEFAULT_TIMEOUT_MS };
export default { register, settle, cancelAll, hasPending, list, DEFAULT_TIMEOUT_MS };
