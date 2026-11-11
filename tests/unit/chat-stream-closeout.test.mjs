import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { chatFunction } from '../helpers/chat-function.mjs'
import {
  closeoutAction,
  shouldProbe,
  streamProbeInterval,
  RESUME_SYNC_MIN_HIDDEN_MS,
  STREAM_PROBE_MS,
  STREAM_RESYNC_MIN_MS,
  STREAM_STALL_MS,
} from '../../frontend/src/lib/stream-closeout.ts'

// 复现手机端那条路径：SSE 一直在收增量（消息都显示完了），但 completed 迟迟不到。
// 断言的是"本地状态必须在 8–10s 内被一条不依赖 completed 的通道收掉"。
test('收到增量但没有 completed：8 秒后必须去核对并收尾（不是 20 秒）', () => {
  const lastEventAt = 1_000_000
  const tick = (ms) => ({ reason: 'tick', now: lastEventAt + ms, lastEventAt, lastProbeAt: 0 })

  assert.equal(shouldProbe(tick(0)), false, '刚收到增量不该立刻探测')
  assert.equal(shouldProbe(tick(3_000)), false, '3s 内还在正常产出，不探测')
  assert.equal(shouldProbe(tick(7_999)), false, '未到静默阈值不探测')

  assert.ok(STREAM_STALL_MS >= 8_000 && STREAM_STALL_MS <= 10_000, '看门狗阈值必须是 8–10s')
  assert.equal(shouldProbe(tick(8_000)), true, '8s 无增量 → 去问服务端')

  // 服务端说"这轮完了" → 本地立刻收尾（清"执行中"、恢复发送键）
  assert.deepEqual(closeoutAction({ done: true, status: 'completed', lastSeq: 42 }, { cursor: 42 }), { action: 'finalize', status: 'completed' })
  // 非正常终态也要收尾，并如实带上原因
  assert.deepEqual(closeoutAction({ done: true, status: 'failed', lastSeq: 42 }, { cursor: 42 }), { action: 'finalize', status: 'failed' })
})

test('页面从后台恢复：立刻同步，不等 8s 静默阈值', () => {
  const now = 2_000_000
  const justGotDelta = { now, lastEventAt: now - 50, lastProbeAt: now - 50 }

  assert.equal(shouldProbe({ reason: 'tick', ...justGotDelta }), false, '前台 tick 仍要等静默阈值')
  assert.equal(shouldProbe({ reason: 'resume', ...justGotDelta }), true, '回到前台必须立刻核对')
  assert.equal(shouldProbe({ reason: 'end', ...justGotDelta }), true, 'SSE 流关闭也要立刻核对')
  assert.equal(shouldProbe({ reason: 'error', ...justGotDelta }), true, 'SSE 断线也要立刻核对')
  assert.equal(shouldProbe({ reason: 'turn_end', ...justGotDelta }), true, '会话总线 turn_end 也要立刻核对')
  assert.ok(RESUME_SYNC_MIN_HIDDEN_MS <= 1_000, '短暂失焦不算"被挂起"')

  // 恢复时服务端已收尾：走同一条 finalize 路径
  assert.equal(closeoutAction({ done: true, status: 'completed', lastSeq: 7 }, { cursor: 7 }).action, 'finalize')
})

test('轮询只在"执行中"开：3s 短轮询，空闲为 0（不耗电）', () => {
  assert.equal(streamProbeInterval(true), STREAM_PROBE_MS)
  assert.ok(STREAM_PROBE_MS >= 3_000 && STREAM_PROBE_MS <= 5_000, '兜底轮询要落在 3–5s')
  assert.equal(streamProbeInterval(false), 0, '空闲不轮询')
})

test('服务端还在跑就不许提前收尾；发现落后才按游标重连', () => {
  assert.deepEqual(closeoutAction({ done: false, status: 'running', lastSeq: 5 }, { cursor: 5 }), { action: 'wait' })
  assert.deepEqual(closeoutAction({ done: false, status: 'running', lastSeq: 9 }, { cursor: 5 }), { action: 'resync', why: 'behind_cursor' })
  assert.deepEqual(closeoutAction(null, { cursor: 5 }), { action: 'resync', why: 'state_unavailable' })
})

// 接线检查：上面这些决策必须真的接在 ChatArea 的三条通道上，否则逻辑再对也不生效。
test('ChatArea 把收尾兜底接在断流、看门狗、回到前台三条通道上', () => {
  const root = new URL('../../', import.meta.url)
  const read = (file) => fs.readFileSync(new URL(file, root), 'utf8')
  const chatArea = read('frontend/src/components/chat/ChatArea.tsx')
  const sendBox = read('frontend/src/components/chat/SendBox.tsx')

  assert.match(chatArea, /from '\.\.\/\.\.\/lib\/stream-closeout'/)
  assert.ok(chatArea.includes("streamSyncRef.current('resume')"), 'visibilitychange 恢复要立刻同步')
  assert.ok(chatArea.includes("streamSyncRef.current('end')"), 'SSE 流结束也要收尾')
  assert.ok(chatArea.includes("streamSyncRef.current('error')"), 'SSE 断线也要收尾')
  assert.ok(chatArea.includes("streamSyncRef.current('tick')"), '看门狗/短轮询要接上')
  assert.match(chatArea, /setRequestInFlight\(false\)/, 'finalize 必须无条件恢复发送键')
  assert.match(chatArea, /streaming=\{requestInFlight\}/, '发送键只取决于"有请求在飞"')
  // 顺序很重要：清"在飞"要排在 finalize 的所有 early return 之前，否则某条收尾路径会漏掉
  const finalizeBody = chatArea.slice(chatArea.indexOf('const finalize = ('))
  assert.ok(finalizeBody.indexOf('setRequestInFlight(false)') < finalizeBody.indexOf('finalizedStreamRef.current === finalizeKey'),
    'setRequestInFlight(false) 必须在幂等 return 之前')

  assert.ok(!sendBox.includes('refreshInterval: 20000'), '聊天输入区不再有 20s 的固定轮询')
})

// 用真实的 ChatArea.syncRunState 跑手机端那条路径：文字收完了、completed 永远不来。
// 打桩的只有"网络"和 React setter，决策仍是真代码（lib/stream-closeout + ChatArea 函数体）。
function runCloseout({ reason, now, lastEventAt, state, stateThrows = null, hidden = false }) {
  const calls = { finalized: 0, resynced: 0, stateAsked: 0, errors: [] }
  const active = { runId: 'run-A', sessionId: 'A', status: 'running', lastSeq: 5, assistantMessageId: 'a1', stream: { text: '', tools: [], notes: [] } }
  const scope = {
    activeRunRef: { current: active },
    sessionIdRef: { current: 'A' },
    isCurrentView: () => true,
    requestInFlight: true,
    setRequestInFlight: v => { calls.requestInFlight = v },
    pendingModelRef: { current: undefined },
    lastEventAtRef: { current: lastEventAt },
    lastProbeAtRef: { current: 0 },
    lastResyncAtRef: { current: 0 },
    probingRef: { current: false },
    document: { hidden },
    Date: { now: () => now },
    closeoutAction, shouldProbe, streamProbeInterval,
    RESUME_SYNC_MIN_HIDDEN_MS, STREAM_RESYNC_MIN_MS,
    RunsApi: { state: () => { calls.stateAsked++; return stateThrows ? Promise.reject(stateThrows) : Promise.resolve(state) } },
    updStream: () => {},
    finalize: () => { calls.finalized++ },
    connectRun: () => { calls.resynced++ },
    emptyStream: () => ({ text: '', tools: [], notes: [] }),
  }
  return chatFunction('syncRunState', scope)(reason).then(() => calls)
}

test('组件路径：消息收完但 completed 不到，第 3s 不动、第 8s 收尾', async () => {
  const lastEventAt = 1_000_000
  const finished = { done: true, status: 'completed', lastSeq: 5 }

  const early = await runCloseout({ reason: 'tick', now: lastEventAt + 3_000, lastEventAt, state: finished })
  assert.equal(early.finalized, 0, '3s 时还在正常产出窗口内，不许收尾')
  assert.equal(early.stateAsked, 0, '没到 8s 连状态都不该问')

  const late = await runCloseout({ reason: 'tick', now: lastEventAt + 8_000, lastEventAt, state: finished })
  assert.equal(late.finalized, 1, '8s 后必须收尾（清"执行中"、恢复发送键）')
})

test('组件路径：服务端还在跑就不收尾；落后游标才重连', async () => {
  const lastEventAt = 2_000_000
  const running = { done: false, status: 'running', lastSeq: 5 }
  const stillRunning = await runCloseout({ reason: 'tick', now: lastEventAt + 20_000, lastEventAt, state: running })
  assert.equal(stillRunning.finalized, 0, '服务端说还在跑，界面必须继续显示执行中')
  assert.equal(stillRunning.resynced, 0, '没落后就别抖连接')

  const behind = await runCloseout({ reason: 'tick', now: lastEventAt + 20_000, lastEventAt, state: { done: false, status: 'running', lastSeq: 9 } })
  assert.equal(behind.finalized, 0)
  assert.equal(behind.resynced, 1, '服务端有没收到的事件 → 按游标重连补发')
})

test('组件路径：页面回到前台立刻收尾（不等到看门狗阈值）', async () => {
  const lastEventAt = 3_000_000
  // 刚刚才收到过增量（100ms 前），前台 tick 不会探测；但 resume 必须立刻探测
  const resumed = await runCloseout({ reason: 'resume', now: lastEventAt + 100, lastEventAt, state: { done: true, status: 'completed', lastSeq: 5 } })
  assert.equal(resumed.stateAsked, 1)
  assert.equal(resumed.finalized, 1, '后台回来必须当场恢复，不能等下一次轮询')
})

test('组件路径：SSE 断流也走同一条收尾（且查不到状态时不本地判死）', async () => {
  const lastEventAt = 4_000_000
  const ended = await runCloseout({ reason: 'end', now: lastEventAt + 10, lastEventAt, state: { done: true, status: 'completed', lastSeq: 5 } })
  assert.equal(ended.finalized, 1, '流关闭 + 服务端说完了 → 收尾')

  const offline = await runCloseout({ reason: 'error', now: lastEventAt + 10, lastEventAt, stateThrows: Object.assign(new Error('offline'), { status: 0 }) })
  assert.equal(offline.finalized, 0, '网络抖动不能把还在跑的轮次收掉')
  assert.equal(offline.resynced, 1, '断线时按游标重连，等服务端补发')
})

