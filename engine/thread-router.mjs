// ===== engine/thread-router.mjs —— 订阅直通（2026-11-07）=====
//
// 来源：Super-agent 的「订阅与直通」。问题很具体：
//   现在所有事件（定时任务、微信消息、任务板动作）都进同一个主会话，
//   一件事处理到一半，另一件事的消息插进来，上下文互相污染、前面的活被打断。
//
// 做法：给"同一条话题"的事件一个稳定的 threadKey，
//   首次事件由主会话接手（并登记订阅），此后同一 threadKey 的事件**直接投给那个 worker**，
//   不再经过主会话。这条 Fast Path 省掉一次路由决策，也避免排队。
//
// 这个模块只做"判定与登记"，不启动会话——调用方拿到 route 结果后自己去派活。
// 纯逻辑、可单测；状态放内存（重启后重新学，代价很小：下一次事件重新冷启动一次）。

/** 事件 → 线程键。没有稳定话题的事件返回空串（走主会话）。 */
export function threadKeyOf(event = {}) {
  if (!event || typeof event !== "object") return "";
  // 微信：同一个聊天（群/私聊）是一条话题
  if (event.chatId) return `wechat:${event.chatId}`;
  // 任务板：同一个任务是一条话题
  if (event.taskId) return `task:${event.taskId}`;
  // 连续创作 / 运行：同一次运行是一条话题
  if (event.runId) return `run:${event.runId}`;
  // 邮件：同一封往来
  if (event.mailThreadId) return `mail:${event.mailThreadId}`;
  // 明确指定了话题就直接用（给将来的 GitHub PR / CI 用）
  if (event.threadId) return String(event.threadId);
  return "";
}

/**
 * 订阅表：threadKey → { workerId, sessionId, since, lastEventAt, count }
 * 一条 thread 会被多个 worker 订阅（多对多），也允许一个 worker 订阅多条。
 */
const subs = new Map(); // threadKey -> Map(workerId -> sub)

function ensure(key) {
  let m = subs.get(key);
  if (!m) { m = new Map(); subs.set(key, m) }
  return m;
}

/** 登记订阅。重复登记会刷新 lastEventAt。 */
export function subscribe(threadKey, { workerId, sessionId = "", now = Date.now() } = {}) {
  const key = String(threadKey || "");
  if (!key || !workerId) return null;
  const m = ensure(key);
  const prev = m.get(workerId);
  const sub = {
    workerId, sessionId,
    since: prev?.since ?? now,
    lastEventAt: now,
    count: (prev?.count || 0) + 1,
  };
  m.set(workerId, sub);
  return sub;
}

/** 取消订阅（worker 判定"这活不归我了"时调用）。 */
export function unsubscribe(threadKey, workerId) {
  const m = subs.get(String(threadKey || ""));
  if (!m) return false;
  const ok = m.delete(workerId);
  if (!m.size) subs.delete(String(threadKey));
  return ok;
}

/** 这个线程有哪些 worker 在订。 */
export function subscribersOf(threadKey) {
  return [...(subs.get(String(threadKey || ""))?.values() || [])];
}

/**
 * 派发判定：有订阅 → 直通（fast path）；没订阅 → 交主会话（slow path）。
 * @returns {{ route: 'direct'|'main', threadKey: string, targets: Array }}
 */
export function route(event = {}, { now = Date.now() } = {}) {
  const threadKey = threadKeyOf(event);
  if (!threadKey) return { route: "main", threadKey: "", targets: [] };
  const targets = subscribersOf(threadKey);
  if (!targets.length) return { route: "main", threadKey, targets: [] };
  for (const t of targets) t.lastEventAt = now;
  return { route: "direct", threadKey, targets };
}

/** 清空（测试与重启用）。 */
export function resetSubscriptions() { subs.clear() }

/** 现况快照（给接口看）。 */
export function snapshot() {
  return [...subs.entries()].map(([threadKey, m]) => ({
    threadKey,
    workers: [...m.values()].map(s => ({ ...s })),
  }));
}
