// 通知「灵动胶囊」的排队逻辑（2026-11-17）：全屏只留一个胶囊，原地变形。
// 纯函数，不碰 DOM，方便单测。状态：{ cur, shownAt, queue }
//
// 规则：
// - 同一句话（同 tone、无 key）再来一次 → 原地 ×N 计数，重新计时，不新开。
// - 带 key 的 → 同一个胶囊里更新文字/进度（任务生命周期：开始 → 进度 → 完成/失败）。
// - 新消息默认直接替换当前的；但报错至少停 ERROR_HOLD_MS，后来的先排队，免得报错一闪就被冲掉。

export const ERROR_HOLD_MS = 2500
export const EMPTY = { cur: null, shownAt: 0, queue: [] }

export function durationOf(item) {
  if (!item) return 0
  if (item.sticky) return Infinity
  return item.tone === 'error' ? 5000 : 3000
}

function sameAs(it, input) {
  if (!it) return false
  if (input.key) return it.key === input.key
  return !it.key && it.msg === input.msg && it.tone === (input.tone || 'info')
}

function merge(it, input) {
  return {
    ...it,
    msg: input.msg,
    tone: input.tone || 'info',
    progress: input.progress ?? null,
    sticky: !!input.sticky,
    count: input.key ? it.count : it.count + 1,
    rev: it.rev + 1,
  }
}

export function pushToast(state, input, now) {
  if (sameAs(state.cur, input)) return { ...state, cur: merge(state.cur, input), shownAt: now }
  const qi = state.queue.findIndex(it => sameAs(it, input))
  if (qi >= 0) return { ...state, queue: state.queue.map((it, i) => (i === qi ? merge(it, input) : it)) }
  const item = {
    id: input.id, key: input.key || null, msg: input.msg, tone: input.tone || 'info',
    progress: input.progress ?? null, sticky: !!input.sticky, count: 1, rev: 0,
  }
  const holding = state.cur && state.cur.tone === 'error' && now - state.shownAt < ERROR_HOLD_MS
  if (holding) return { ...state, queue: [...state.queue, item].slice(-5) }
  return { cur: item, shownAt: now, queue: state.queue }
}

export function expireToast(state, now) {
  const [next, ...rest] = state.queue
  return next ? { cur: next, shownAt: now, queue: rest } : { cur: null, shownAt: now, queue: [] }
}

export function dismissToast(state, key, now) {
  if (state.cur && state.cur.key === key) return expireToast(state, now)
  return { ...state, queue: state.queue.filter(it => it.key !== key) }
}

// 当前胶囊还要停多久：有人排队时，报错停满保底时间就让位；否则按各自时长。
export function nextDelay(state, now) {
  if (!state.cur) return Infinity
  const elapsed = now - state.shownAt
  if (state.queue.length) return Math.max(0, ERROR_HOLD_MS - elapsed)
  return Math.max(0, durationOf(state.cur) - elapsed)
}
