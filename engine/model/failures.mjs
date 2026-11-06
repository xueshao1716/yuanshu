// 连续失败计数：把"这条路现在不通"变成可执行的回避，而不是每一轮都撞一次墙。
//
// 为什么需要它：pi 通道的失败**不抛异常**——它落成一条 stopReason=error 的 assistant 记录，
// 界面此前还会把这条记录滤掉，于是用户只看到"它不说话/变傻了"。
// 现有 markModelBlocked 只在 auto_retry_start 事件里按 HTTP 状态码标冷却；
// 像 TypeError、协议不兼容这类**没有状态码**的失败，之前完全没人管。
//
// 约定：
//   noteModelFailure() 同一条路连续失败到阈值 → blocked=true（调用方再去 markModelBlocked）；
//   clearModelFailures() 一次成功即清零（不搞"错一次记一辈子"）；
//   时间窗外的旧失败不算数，避免把偶发失败累积成永久封禁。
const WINDOW_MS = 10 * 60 * 1000;
const BLOCK_AFTER = 2;
const failures = new Map();

export function modelFailureKey(model) {
  if (!model) return "";
  const provider = String(model.provider || "").trim();
  const id = String(model.id || model.model || "").trim();
  return provider && id ? `${provider}/${id}` : "";
}

export function noteModelFailure(model, reason = "") {
  const key = modelFailureKey(model);
  if (!key) return { key: "", count: 0, blocked: false };
  const now = Date.now();
  const prev = failures.get(key);
  const fresh = prev && now - prev.lastAt <= WINDOW_MS ? prev : { count: 0, firstAt: now };
  const next = {
    count: fresh.count + 1,
    firstAt: fresh.firstAt || now,
    lastAt: now,
    reason: String(reason || "").slice(0, 300),
  };
  failures.set(key, next);
  return { key, count: next.count, blocked: next.count >= BLOCK_AFTER, reason: next.reason };
}

export function clearModelFailures(model) {
  const key = modelFailureKey(model);
  if (!key) return false;
  return failures.delete(key);
}

export function modelFailureState(model) {
  const key = modelFailureKey(model);
  if (!key) return null;
  const f = failures.get(key);
  if (!f) return null;
  if (Date.now() - f.lastAt > WINDOW_MS) { failures.delete(key); return null; }
  return { key, count: f.count, reason: f.reason, lastAt: f.lastAt };
}

export function listModelFailures() {
  return [...failures.entries()].map(([key, f]) => ({ key, ...f }));
}

export function resetModelFailures() {
  failures.clear();
}

export const MODEL_FAILURE_BLOCK_AFTER = BLOCK_AFTER;
export const MODEL_FAILURE_WINDOW_MS = WINDOW_MS;
