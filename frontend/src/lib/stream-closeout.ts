/**
 * 手机端收尾兜底（2026-11-11）
 *
 * 为什么需要它：一轮任务"结束"这件事，前端只认 Run SSE 的 `completed` 事件
 * （ChatArea 的 `done` 只记模型，真正收尾的是 `completed` → finalize）。
 * 桌面网线直连能立刻收到，手机 WebView / 移动网络会把 SSE 尾部攒在缓冲区里，
 * 或者把连接静默挂起 —— 于是用户看到的是："消息都显示完了，'执行中'和发送键
 * 还要再挂二十秒"。前端此前没有任何"不依赖 completed"的收尾通道。
 *
 * 这里只放决策，不放副作用（便于单测，不依赖 React / DOM）：
 *   ① 没有任何增量事件超过 STREAM_STALL_MS → 去问服务端轻量状态 /api/runs/:id/state；
 *   ② 页面从后台回到前台 → 立刻问一次，不等看门狗；
 *   ③ 短轮询只在"执行中"开，空闲返回 0（不耗电）。
 *
 * 注意：看门狗**不**在本地直接判死。长工具（出图/出片）几十秒没有任何事件是常态，
 * 本地硬收尾会让"还在跑的轮子"看起来已结束、续写又追一条重复消息。所以静默超时后
 * 先问服务端：服务端说完了才收尾，说还在跑就继续等。
 */

/** 8s 无增量 → 核对一次（需求给的区间是 8–10s；别学服务端那 20s 的心跳） */
export const STREAM_STALL_MS = 8_000

/** 执行中的兜底轮询间隔（3–5s），空闲不轮询 */
export const STREAM_PROBE_MS = 3_000

/** 两次"按游标重连"之间的最小间隔，防止网络半死时每 4s 抖一次 */
export const STREAM_RESYNC_MIN_MS = 8_000

/** 页面隐藏超过这么久再回来，才认为连接可能已被挂起 */
export const RESUME_SYNC_MIN_HIDDEN_MS = 1_000

/** 服务端 /api/runs/:id/state 里前端关心的字段 */
export interface RunStateLike {
  done?: boolean
  status?: string | null
  lastSeq?: number | null
}

export type CloseoutAction =
  | { action: 'wait' }
  | { action: 'finalize'; status: string }
  | { action: 'resync'; why: string }

/** 触发一次状态核对的原因 */
export type ProbeReason = 'tick' | 'resume' | 'end' | 'error' | 'turn_end'

/** 只有"执行中"才轮询；空闲返回 0（setInterval 用 0 表示不启用） */
export function streamProbeInterval(active: boolean): number {
  return active ? STREAM_PROBE_MS : 0
}

/**
 * 这次事件要不要真的去问服务端？
 * - resume / end / error / turn_end：外部信号，立刻问（这正是"不等看门狗"的那条路）；
 * - tick：定时器心跳，必须满足"≥8s 没有增量"且"距上次核对 ≥3s"。
 */
export function shouldProbe({ reason, now, lastEventAt, lastProbeAt }: {
  reason: ProbeReason
  now: number
  lastEventAt: number
  lastProbeAt: number
}): boolean {
  if (reason !== 'tick') return true
  if (now - lastEventAt < STREAM_STALL_MS) return false
  return now - lastProbeAt >= STREAM_PROBE_MS
}

/**
 * 服务端轻量状态的裁决：
 * - done → finalize（这就是手机上被 SSE 拖住的那条收尾路径）；
 * - 服务端还有我们没收到的事件（lastSeq > 本地游标）→ 按游标重连，服务端会补发；
 * - 其余（还在跑、没落后）→ wait，绝不提前收尾。
 */
export function closeoutAction(state: RunStateLike | null | undefined, { cursor = 0 }: { cursor?: number } = {}): CloseoutAction {
  if (!state) return { action: 'resync', why: 'state_unavailable' }
  if (state.done) return { action: 'finalize', status: String(state.status || 'completed') }
  const lastSeq = Number(state.lastSeq)
  if (Number.isFinite(lastSeq) && lastSeq > cursor) return { action: 'resync', why: 'behind_cursor' }
  return { action: 'wait' }
}
