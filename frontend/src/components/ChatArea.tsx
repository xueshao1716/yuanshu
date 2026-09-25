import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useApp } from '../store'
import { MessagesSquare, BrainCircuit, Wrench, FolderClosed, Plus, SquareTerminal, Command, ChevronDown, ChevronRight, PanelRight, ShieldAlert, ImagePlus, Presentation, Clock4, Database, Download, FileText, Code2 } from 'lucide-react'
import { RefreshCw } from 'lucide-react'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { RunApi, RunsApi, SessionsApi, AsrApi, AgentStatusApi, streamSession, LingXiApi, ConfirmApi, downloadApiFile, type RunSummary } from '../api'
import Message from './Message'
import ChatMediaProvider from './ChatMediaProvider'
import SendBox from './SendBox'
import XiaoyuWidget from './XiaoyuWidget'
import TurnList from './TurnList'
import ChatRunStatus from './ChatRunStatus'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { toast } from './Toast'
import { emoTooltip } from '../lib/emotion'
import { useXiaoyuEmotion } from '../lib/useXiaoyuEmotion'
import { MoodOrb } from './MoodOrb'
import type { FileAttachment } from './SendBox'
import type { ChatMessage, RunningTool } from '../types'
import { saveMessage, getMessages, deleteMessage, mergeMessages, type LocalMessage } from '../lib/local-db'
import { notifyTaskDone } from '../lib/notify'
import { StreamAssembler, type AssemblerSnapshot } from '../lib/stream-assembler'
import { advanceRunCursor, isTerminalRunStatus, interruptionNotice, type RunCursor, type RunEvent } from '../lib/run-events'
import { scrapeVideos, dedupeMediaUrls, mediaPathKey } from '../lib/media-embed'
import { reconcileImageMessages } from '../lib/image-identity'

// 流式状态：覆盖服务端全部 SSE 事件（delta/think/think_end/tool/tool_output/
// tool_end/turn_end/file/image/media/note/emotion/done/error）
interface StreamState {
  text: string
  think: string
  thinkDone: boolean
  conclusion: string
  tools: RunningTool[]
  notes: string[]
  files: { path: string; name?: string }[]
  images: string[]
  audios: string[]
  videos: string[]
  error?: string
  model?: { provider: string; id: string }
  requestedModel?: { provider: string; id: string }
  // 本轮主驾引擎（服务端 engine_selected 事件）：yuanshu / pi / dsh + 原因
  engine?: string
  engineReason?: string
  // 本轮回答被"重写/换模型"过（服务端 model_switched 事件）：复读修正、空回复兜底、守卫换模型都会推
  switchedModel?: { provider: string; id: string; sameModel: boolean; reason: string }
}

const emptyStream = (): StreamState => ({ text: '', think: '', thinkDone: false, conclusion: '', tools: [], notes: [], files: [], images: [], audios: [], videos: [] })

const RIGHT_PANEL_LABELS: Record<string, string> = {
  workspace: '工作区', deliveries: '交付物', terminal: '终端', activity: '活动', tui: 'TUI',
}

// 10 分钟无新事件后只提示；前端看不到事件不能推断服务端 Run 已失活。
const IDLE_WARN_MS = 600_000

interface ActiveRunRecord extends RunCursor {
  sessionId: string
  assistantMessageId: string
  stream: StreamState
}

const activeRunKey = (sessionId: string) => `pi_active_run:${sessionId}`

function loadActiveRun(sessionId: string): ActiveRunRecord | null {
  try {
    const value = JSON.parse(localStorage.getItem(activeRunKey(sessionId)) || 'null')
    return value?.runId && value.sessionId === sessionId ? value : null
  } catch { return null }
}

function saveActiveRun(record: ActiveRunRecord) {
  try {
    // 大图片/音频不进 localStorage；文本、工具与 seq 必须同一次写入，避免游标领先快照后无法重放。
    localStorage.setItem(activeRunKey(record.sessionId), JSON.stringify({
      ...record,
      stream: { ...record.stream, images: [], audios: [], videos: [] },
    }))
  } catch {}
}

function clearActiveRun(sessionId: string) {
  try { localStorage.removeItem(activeRunKey(sessionId)) } catch {}
}

function toDataUri(raw: string, mime?: string): string {
  return raw.startsWith('data:') ? raw : `data:${mime || 'image/png'};base64,${raw}`
}

function friendlyStreamError(raw?: string) {
  if (!raw) return ''
  if (/fetch failed|Failed to fetch/i.test(raw)) {
    return '上游网络失败（代理或出图/模型接口不通）。出图失败不该挡住思考和工具；看上面过程区判断停在哪。'
  }
  return raw
}

export default function ChatArea({ compactHeader, rightPanel, onRightPanel }: {
  compactHeader?: boolean
  /** 右栏状态由 AppLayout 持有；传入则顶栏显示"右栏"开关（与状态胶囊并排，不再悬浮遮挡） */
  rightPanel?: string
  onRightPanel?: (p: any) => void
} = {}) {
  const { currentSessionId, currentModel, sessions, refreshSessions, selectSession } = useApp()
  // 人格定义（2026-09-19）：顶栏显示"名字 · 年龄"，让定义在界面上看得见（改定义这里跟着变）
  const { data: personaData } = useSWR('persona', () => fetch('/api/persona', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('yuanshu_access_token') || '') } }).then(r => r.json()))
  // 顶栏只显示名字（用户 2026-09-19：手机端左上角写「小语」就行，别带「· 20岁」；
  // 年龄仍然在挂件气泡里能看到——那是"定义驱动"该露的地方，不是标题栏）
  const personaLabel = (() => { const d = personaData?.definition; return d?.name || '小语' })()
  const sessionIdRef = useRef(currentSessionId)
  sessionIdRef.current = currentSessionId
  const [stream, setStream] = useState<StreamState | null>(null)
  const [confirm, setConfirm] = useState<any>(null) // 危险操作待确认：{ id, toolName, reason, args, sessionId }
  const [exportOpen, setExportOpen] = useState(false)
  const [exportingFormat, setExportingFormat] = useState<'html' | 'jsonl' | null>(null)
  useEffect(() => {
    if (!exportOpen) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') setExportOpen(false)
      if (event instanceof MouseEvent && !(event.target as HTMLElement)?.closest('.chat-export-wrap')) setExportOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [exportOpen])
  const [idleSeconds, setIdleSeconds] = useState(0)
  const streamCloseRef = useRef<(() => void) | null>(null)
  const activeRunRef = useRef<ActiveRunRecord | null>(null)
  const pendingModelRef = useRef<{ provider: string; id: string } | undefined>(undefined)
  // ref 是唯一事实源：SSE 事件可能在一个渲染批次内全部到达，useEffect 同步会滞后导致 done 时读到旧值
  const streamRef = useRef<StreamState | null>(null)
  // 流式组装器：阶段分流 + 16ms 合帧 + toolCallId 幂等（旧版 vanilla 机制恢复，见 lib/stream-assembler.ts）
  const asmRef = useRef<StreamAssembler | null>(null)
  const lastEventAtRef = useRef(0)
  const assistantMsgIdRef = useRef<string | null>(null) // 本轮 assistant 消息的固定 id，流式期间快照与最终写入用同一 id（避免重复）
  // 同一轮只收尾一次（finalize 有 6 个调用点，重复触发会造成"消息出现两次"）
  const finalizedStreamRef = useRef<any>(null)
  const wasBackgroundRef = useRef(false) // 本轮流式期间是否曾去过后台（哪怕又切回来了），放宽通知触发条件用

  // ── 消息缓存：正常阅读不反复重载；跨端切回、断线重连时允许 SWR 取最新正文。
  const msgKey = currentSessionId ? ['messages', currentSessionId] : null
  const { data: msgData, isLoading, mutate: mutateMsgs } = useSWR(msgKey,
    ([, sid]: readonly [string, string]) => SessionsApi.messages(sid, { tail: 80 }),
    { revalidateOnFocus: true, revalidateOnReconnect: true, dedupingInterval: 3000 })
  const { state: emoState, meta: emoMetaLive, publishEmotion } = useXiaoyuEmotion()
  // ── 本地消息存储：从 IndexedDB 加载，与服务端数据合并 ──
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([])
  const [localLoaded, setLocalLoaded] = useState(false)

  // 切会话时：加载本地消息
  useEffect(() => {
    if (!currentSessionId) { setLocalMessages([]); setLocalLoaded(false); return }
    let alive = true
    setLocalLoaded(false)
    getMessages(currentSessionId).then(localMsgs => {
      if (!alive) return
      // 转换成 ChatMessage 格式
      const msgs = localMsgs.map(lm => ({
        id: lm.id,
        role: lm.role,
        text: lm.text,
        think: lm.think,
        tools: lm.tools,
        notes: lm.notes,
        files: lm.files,
        images: lm.images,
        audios: lm.audios,
        videos: lm.videos,
        model: lm.model,
        requestedModel: lm.requestedModel,
        switchedModel: lm.switchedModel,
        engine: lm.engine,
        ts: lm.ts,
        streaming: lm.streaming,
        isDraft: lm.draft,
      } as ChatMessage))
      setLocalMessages(msgs)
      setLocalLoaded(true)
    }).catch(() => {
      setLocalMessages([])
      setLocalLoaded(true)
    })
    return () => { alive = false }
  }, [currentSessionId])

  // 实时快照也参与归并：焦点/重连刷新可能已拿到本轮的分段历史。
  // 用最新快照认领这些分段，统一由下方 streamingNode 展示，避免双渲染。
  const liveSnapshot: LocalMessage | null = stream ? {
    ...stream, id: assistantMsgIdRef.current || '__streaming__',
    sessionId: currentSessionId || '', role: 'assistant',
    ts: new Date().toISOString(), synced: false, draft: true, streaming: true,
  } : null
  const messages: ChatMessage[] = (localLoaded || liveSnapshot) && msgData
    ? mergeMessages(
        localMessages.filter(m => !liveSnapshot || (!m.isDraft && m.id !== liveSnapshot.id)).map<LocalMessage>(m => ({
          id: m.id,
          sessionId: currentSessionId || '',
          role: m.role,
          text: m.text || '',
          think: m.think,
          tools: m.tools,
          notes: m.notes,
          files: m.files,
          images: m.images,
          audios: m.audios,
          videos: m.videos,
          model: m.model,
          requestedModel: m.requestedModel,
          ts: m.ts,
          error: m.error,
          stopReason: m.stopReason,
          truncated: m.truncated,
          engine: m.engine,

          switchedModel: m.switchedModel,
          engineReason: m.engineReason,
          synced: !m.isDraft,
          draft: !!m.isDraft,
          streaming: m.streaming,
        })).concat(liveSnapshot ? [liveSnapshot] : []),
        msgData.messages || []
      ).map(lm => ({
        id: lm.id,
        role: lm.role,
        text: lm.text,
        think: lm.think,
        tools: lm.tools,
        notes: lm.notes,
        files: lm.files,
        images: lm.images,
        audios: lm.audios,
        videos: lm.videos,
        model: lm.model,
        requestedModel: lm.requestedModel,
        ts: lm.ts,
        // 失败记录必须活到界面上（2026-09-16）：后端 extractMessages 现在会带 error/stopReason
        error: lm.error,
        stopReason: lm.stopReason,
        truncated: lm.truncated,
        // ② 引擎角标：服务端的 engine_selected 只活在流式状态里，本地库这一份负责刷新后还能看见
        engine: (lm as any).engine,

        switchedModel: (lm as any).switchedModel,
        engineReason: (lm as any).engineReason,
        streaming: lm.streaming,
        isDraft: lm.draft,
      } as ChatMessage))
    : localLoaded
      ? localMessages
      : (msgData?.messages || [])

  // 保存消息到本地 IndexedDB
  const saveToLocal = async (msg: ChatMessage) => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    try {
      await saveMessage({
        id: msg.id,
        sessionId,
        role: msg.role,
        text: msg.text || '',
        think: msg.think,
        tools: msg.tools,
        notes: msg.notes,
        files: msg.files,
        images: msg.images,
        audios: msg.audios,
        videos: msg.videos,
        model: msg.model,
        requestedModel: msg.requestedModel,
        ts: msg.ts,
        engine: msg.engine,

        switchedModel: msg.switchedModel,
        engineReason: msg.engineReason,
        synced: !msg.streaming && !msg.isDraft,
        draft: !!msg.isDraft || !!msg.streaming,
        streaming: msg.streaming,
      })
      // 更新本地消息列表
      setLocalMessages(prev => {
        const exists = prev.find(m => m.id === msg.id)
        if (exists) return prev.map(m => m.id === msg.id ? msg : m)
        return [...prev, msg]
      })
    } catch (e) {
      console.error('[local-db] 保存消息失败:', e)
    }
  }

  // 手机息屏/切到另一端后恢复：先落盘本端流缓冲，再同时刷新目录与当前正文。
  // 流式 Run 仍由持久化事件游标恢复；正在流式时不拉整段正文，避免覆盖实时草稿。
  useEffect(() => {
    let hiddenAt = 0
    const onVis = () => {
      if (document.hidden) { hiddenAt = Date.now(); if (streamRef.current) wasBackgroundRef.current = true; return }
      // 息屏恢复：先把组装器缓冲强制落盘，再刷新会话目录（旧版 flushNow 行为）
      asmRef.current?.flushNow()
      if (hiddenAt && Date.now() - hiddenAt > 1_000 && !streamRef.current) {
        void mutateMsgs()
        void refreshSessions()
      }
      hiddenAt = 0
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [mutateMsgs, refreshSessions])

  const pull = usePullToRefresh(async () => {
    await mutateMsgs()
    await refreshSessions()
  })
    // 用户消息防丢现已改由 IndexedDB 本地存储承担（send() 里 appendMessage 发送时即写入本地），无需再依赖旧版 localStorage pi_pending_msg + 手动插入 SWR 缓存的方式。

  const loading = !!msgKey && isLoading && !msgData

  // 本地乐观更新（发送/收尾/系统提示），不触发重验证
  const updateMessages = (fn: (prev: ChatMessage[]) => ChatMessage[]) => {
    if (!currentSessionId) return
    mutateMsgs(prev => ({ ...(prev || { messages: [] as ChatMessage[] }), messages: fn(prev?.messages || []) }), { revalidate: false })
  }

  // 追加一条消息：同时写入 SWR 乘机缓存 + IndexedDB 本地持久化。
  // 写本地 IndexedDB 与服务端 JSONL 完全独立，不会产生重复写入问题，因此用户消息也可以安全地立即存本地。
  const appendMessage = (msg: ChatMessage) => {
    // 去重（2026-09-20）：同 id 覆盖；同角色 + 同长文本（>120 字）视为同一份，跳过。
    // 这一层是兜底——即使 finalize 被重复触发，也不会在屏幕上出现两份。
    updateMessages(prev => {
      const i = prev.findIndex(m => m.id === msg.id)
      if (i >= 0) { const next = [...prev]; next[i] = msg; return next }
      if (msg.text && msg.text.length > 120 && prev.some(m => m.role === msg.role && m.text === msg.text)) return prev
      return [...prev, msg]
    })
    saveToLocal(msg)
  }

  const reload = () => { if (currentSessionId) mutateMsgs() }

  // 未完成的本地草稿（刷新/重启后从 IndexedDB 恢复）：只在当前没有活跃流式时展示
  const renderMessages = stream ? messages.filter(m => !m.isDraft) : messages
  const draftMsg = !stream ? renderMessages.find(m => m.isDraft) : undefined
  const normalMessages = draftMsg ? renderMessages.filter(m => m.id !== draftMsg.id) : renderMessages

  // 智能滚动（nomifun useAutoScroll 模式）：用户上翻停滚、贴底恢复、仅"真新消息"才强拉底
  const lastMsg = messages[messages.length - 1]
  const streamingLen = stream ? 1 : 0 // 流式中的临时消息也计入指纹，增长由 ResizeObserver 跟随
  const { scrollRef, scrollToBottom: scroll, atBottom } = useAutoScroll({
    sessionKey: currentSessionId,
    lastMessageKey: messages.length
      ? `${messages.length}:${lastMsg?.id ?? ''}:${streamingLen}`
      : (stream ? 'stream' : null),
    lastFromUser: lastMsg?.role === 'user' || (!!stream && !stream.text && !stream.tools.length),
  })

  // 切会话只关闭本端订阅，不停止服务端 Run；该会话再次进入时会按游标恢复。
  useEffect(() => {
    streamCloseRef.current?.()
    streamCloseRef.current = null
    activeRunRef.current = null
    assistantMsgIdRef.current = null
    streamRef.current = null
    teardownAssembler()
    setStream(null)
  }, [currentSessionId])
  // 多端同步：只在新消息或一轮完成的提交边界合并历史。
  // 不能把每个 delta/工具事件都转成整段 messages 请求，否则长会话会持续闪屏并跳阅读位置。
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!currentSessionId) return
    let alive = true
    const syncCommittedHistory = () => {
      if (streamRef.current || !alive) return
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
      syncTimerRef.current = setTimeout(() => { if (alive && !streamRef.current) mutateMsgs() }, 500)
    }
    let primed = false
    const off = streamSession(currentSessionId, 0, (event) => {
      if (!event?.type && Number.isInteger(event?.lastSeq)) { primed = true; return }
      if (!primed) return
      if (event?.type === 'message' || event?.type === 'turn_end' || event?.type === 'session_updated') syncCommittedHistory()
    })
    return () => { alive = false; off(); if (syncTimerRef.current) clearTimeout(syncTimerRef.current) }
  }, [currentSessionId]) // eslint-disable-line

  // 更新流式状态：改 ref → 同步渲染副本
  const updStream = (fn: (p: StreamState) => StreamState | null) => {
    const cur = streamRef.current
    if (!cur) return
    const updated = fn(cur)
    const next = updated ? reconcileImageMessages([updated])[0] : null
    streamRef.current = next
    if (next && activeRunRef.current) {
      activeRunRef.current = { ...activeRunRef.current, stream: next }
    }
    setStream(next ? { ...next } : null)
  }

  // ── 流式组装器管理 ──
  // delta/think/tool 不再逐事件 setState，而是进 assembler 缓冲，16ms 合帧后一次性套用快照
  const teardownAssembler = () => {
    asmRef.current?.dispose()
    asmRef.current = null
  }
  const makeAssembler = () => {
    teardownAssembler()
    asmRef.current = new StreamAssembler((snap: AssemblerSnapshot) => {
      updStream(p => ({ ...p, text: snap.text, conclusion: snap.conclusion, think: snap.think, thinkDone: snap.thinkDone, tools: snap.tools }))
    })
    return asmRef.current
  }

  // 空闲计时器只更新显示，不停止任务；页面隐藏、断连、深思和长工具执行都可能暂时没有事件。
  const streaming = !!stream
  useEffect(() => {
    if (!streaming) { setIdleSeconds(0); return }
    lastEventAtRef.current = Date.now()
    const t = setInterval(() => {
      const idle = Math.floor((Date.now() - lastEventAtRef.current) / 1000)
      setIdleSeconds(idle)
    }, 1000)
    return () => clearInterval(t)
  }, [streaming])

  // 流式增量持久化：每 3s 快照到 IndexedDB（同 id 覆盖写入，不会重复），刷新后可从本地恢复未完成的回复
  // 注意：只依赖 streaming（true/false）控制定时器启停，不能依赖 stream 对象本身——
  // 否则每个 delta 到达都会重建定时器，3s 永远跡不完，快照永远不会真正触发。
  // 定时回调里直接读 streamRef.current（它是同步的最新值，updStream 里每次都会同步写入），不依赖闭包里的 stream。
  useEffect(() => {
    if (!streaming || !currentSessionId) return
    const t = setInterval(() => {
      const s = streamRef.current
      if (!s || !assistantMsgIdRef.current) return
      if (activeRunRef.current) saveActiveRun({ ...activeRunRef.current, stream: s })
      if (!s.text && !s.tools.length && !s.think) return // 空内容不存
      saveToLocal({
        id: assistantMsgIdRef.current,
        role: 'assistant',
        text: s.text,
        think: s.think,
        tools: s.tools,
        notes: s.notes,
        files: s.files,
        images: s.images,
        audios: s.audios,
        videos: s.videos,
        ts: new Date().toISOString(),
        streaming: true,
        isDraft: true,
      })
    }, 3000)
    return () => clearInterval(t)
  }, [streaming, currentSessionId])

  const finalize = (model?: { provider: string; id: string }) => {
    // 只有持久化 Run 进入终态才收尾；普通 SSE 断线/错误事件不会结束后台任务。
    try { localStorage.removeItem('pi_pending_msg') } catch {}
    // 收尾前强制落盘组装器缓冲，确保最后一截增量不丢
    asmRef.current?.flushNow()
    teardownAssembler()
    const active = activeRunRef.current
    const s = streamRef.current
    const finalId = assistantMsgIdRef.current
    // 2026-09-20：同一轮只收尾一次。finalize 有 6 个调用点（SSE done/error/abort/运行终态…），
    // 重复触发时第一次已把 assistantMsgIdRef 清空，第二次会生成新 id → 追加出**第二条同内容消息**（屏幕上就是"消息出现两次"）。
    if (finalizedStreamRef.current === s) return
    finalizedStreamRef.current = s
    streamCloseRef.current?.()
    streamCloseRef.current = null
    assistantMsgIdRef.current = null
    pendingModelRef.current = undefined
    if (active) clearActiveRun(active.sessionId)
    activeRunRef.current = null
    if (!s) return
    const scraped = scrapeVideos(s.text)
    const videos = dedupeMediaUrls([...s.videos, ...scraped])
    if (s.text || s.think || s.tools.length || s.notes.length || s.files.length || s.images.length || s.audios.length || videos.length || s.error) {
      appendMessage({
        id: finalId || ('a' + Date.now()), role: 'assistant',
        text: s.text + (s.error ? `\n\n⚠️ ${friendlyStreamError(s.error)}` : ''),
        think: s.think, tools: s.tools, notes: s.notes,
        files: s.files, images: s.images, audios: s.audios, videos,
        ts: new Date().toISOString(),
        streaming: false, isDraft: false,
        // 失败原因单独存一份（2026-09-16）：以前只把它拼进 text，于是"失败"看起来只是回复里的一句话；
        // 现在本地库也留 error，刷新后仍渲染成可重试的失败条
        ...(s.error ? { error: friendlyStreamError(s.error), stopReason: 'error' } : {}),
        // ② 主驾引擎随消息存下来（"这条回复是谁在干活"要能回看）
        ...(s.engine ? { engine: s.engine, engineReason: s.engineReason || '' } : {}),
        // 被重写/换模型也要随消息存下来（刷新后仍然看得见"这段不是原模型写的"）
        ...(s.switchedModel ? { switchedModel: s.switchedModel } : {}),
        ...((model || s.model) ? { model: model || s.model } : {}),
        ...(s.requestedModel ? { requestedModel: s.requestedModel } : {}),
      })
      // 完成提示音：双声"叮叮"（800Hz 0.1s + 1000Hz 0.15s）
      try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        gain.gain.value = 0.25
        osc.frequency.value = 800
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.1)
        const osc2 = ctx.createOscillator()
        const gain2 = ctx.createGain()
        osc2.connect(gain2)
        gain2.connect(ctx.destination)
        gain2.gain.value = 0.25
        osc2.frequency.value = 1000
        osc2.start(ctx.currentTime + 0.15)
        osc2.stop(ctx.currentTime + 0.3)
      } catch {}
      // 任务完成系统通知（安卓原生桥/Windows Tauri 插件统一入口，见 lib/notify.ts）：
      // 页面不可见（App 在后台/锁屏）或本轮流式期间曾去过后台（哪怕又切回来）都弹，
      // 旧条件只看完成那一瞬间是否在后台，错过了“发送后切到其它 App，回来时刚好生成完成”这种典型场景。
      const shouldNotify = document.visibilityState === 'hidden' || wasBackgroundRef.current
      if (shouldNotify) {
        const preview = (s.text || '').replace(/\s+/g, ' ').trim().slice(0, 60) || (s.error ? `出错：${s.error}` : '有新回复')
        notifyTaskDone('小语 · 任务完成', preview)
      }
      wasBackgroundRef.current = false // 收尾已处理完，重置供下一轮使用
    }
    streamRef.current = null
    setStream(null)
    mutateMsgs()
    refreshSessions()
  }

  const applyRunEvent = (event: RunEvent) => {
    const active = activeRunRef.current
    if (!active) return
    const advanced = advanceRunCursor(active, event)
    if (!advanced.accepted) return
    const nextActive: ActiveRunRecord = { ...active, ...advanced.cursor }
    activeRunRef.current = nextActive
    lastEventAtRef.current = Date.now()
    const d = event.data || {}

    switch (event.type) {
      case 'model_selected':
        if (d.requestedModel) updStream(p => ({ ...p, requestedModel: d.requestedModel }))
        break
      case 'model_used':
        if (d.model) {
          pendingModelRef.current = d.model
          updStream(p => ({ ...p, model: d.model, requestedModel: d.requestedModel || p.requestedModel }))
        }
        break
      case 'response_replace':
        asmRef.current?.replaceResponse(String(d.text || ''), String(d.think || ''))
        break
      case 'subagent_started':
      case 'subagent_finished':
        updStream(p => ({ ...p, notes: [...p.notes, `${d.agent || '角色'} · ${event.type === 'subagent_started' ? '开始协作' : d.status === 'failed' ? '执行失败' : '已返回，待最终检查'}`].slice(-40) }))
        break
      case 'engine_selected': {
        // ② 每轮标出"主驾引擎 + 原因"（2026-09-16）：服务端一直有这个事件，
        // 但前端以前把它丢了——于是"切个模型怎么连引擎和脾气都变了"全靠猜。
        const engine = String(d.engine || '')
        if (engine) updStream(p => ({ ...p, engine, engineReason: String(d.reason || '') }))
        break
      }
      case 'model_switched': {
        // 回答被重写/换模型了，必须让用户看见（他原话："静默换成 agnes 3.0"）
        const id = String(d.id || '')
        if (id) {
          pendingModelRef.current = { provider: String(d.provider || ''), id }
          updStream(p => ({
            ...p,
            model: { provider: String(d.provider || ''), id },
            requestedModel: d.requestedModel || p.requestedModel,
            switchedModel: { provider: String(d.provider || ''), id, sameModel: d.sameModel === true, reason: String(d.reason || '') },
          }))
        }
        break
      }
      case 'delta':
      case 'message': {
        const text = d.text || d.delta?.text || ''
        // 组装器负责阶段分流（工具前/结论区）与 16ms 合帧；text 快照仍为完整逻辑文本
        if (text) asmRef.current?.addDelta(text)
        break
      }
      case 'think': {
        const text = d.think || d.text || ''
        if (text) asmRef.current?.addThink(text)
        break
      }
      case 'think_end':
        asmRef.current?.endThink()
        break
      case 'tool': {
        const id = d.id || `t${event.seq}`
        asmRef.current?.toolStart({ ...d, id })
        break
      }
      case 'tool_output':
        asmRef.current?.toolOutput(d.id, d.text || '')
        break
      case 'tool_end':
        asmRef.current?.toolEnd(d.id, !!d.isError, d.output)
        break
      case 'file':
        if (d.path) updStream(p => ({ ...p, files: [...p.files, { path: d.path, name: d.name }] }))
        break
      case 'image':
        if (d.data) updStream(p => ({ ...p, images: [...p.images, toDataUri(d.data, d.mimeType)] }))
        break
      case 'media':
        if (d.type === 'image' && d.url) updStream(p => ({ ...p, images: dedupeMediaUrls([...p.images, d.url]) }))
        else if (d.type === 'audio' && d.url) updStream(p => ({ ...p, audios: dedupeMediaUrls([...p.audios, d.url]) }))
        else if (d.type === 'video' && d.url) {
          updStream(p => {
            const k = mediaPathKey(d.url)
            if (k && p.videos.some(u => mediaPathKey(u) === k)) return p
            return { ...p, videos: [...p.videos, d.url] }
          })
        }
        break
      case 'recovery_scheduled':
        updStream(p => ({ ...p, notes: [...p.notes, d.message || '正在后台接续任务…'] }))
        break
      case 'note':
        updStream(p => ({ ...p, notes: [...p.notes, d.text || d.note || ''].filter(Boolean) }))
        break
      case 'emotion':
        if (d.state && typeof d.state.valence !== 'undefined') publishEmotion(d.state)
        break
      case 'confirm':
        setConfirm({ id: d.id, toolName: d.toolName, reason: d.reason, args: d.args || {}, sessionId: d.sessionId || '' })
        break
      case 'done':
      case 'finish':
        if (d.model) pendingModelRef.current = d.model
        if (d.model || d.requestedModel) updStream(p => ({ ...p, model: d.model || p.model, requestedModel: d.requestedModel || p.requestedModel }))
        break
      case 'error':
        updStream(p => ({ ...p, error: friendlyStreamError(d.message || d.error || '未知错误') }))
        asmRef.current?.flushNow()
        break
      case 'failed':
        updStream(p => ({ ...p, error: p.error || friendlyStreamError(d.message || '任务执行失败') }))
        asmRef.current?.flushNow()
        finalize(pendingModelRef.current)
        break
      case 'stopped':
        updStream(p => ({ ...p, error: p.error || '已手动停止', tools: p.tools.map(t => t.status === 'running' ? { ...t, running: false, status: 'canceled' } : t) }))
        asmRef.current?.flushNow()
        finalize(pendingModelRef.current)
        break
      case 'interrupted': {
        const notice = interruptionNotice(d)
        if (d.model) pendingModelRef.current = d.model
        updStream(p => ({ ...p, error: p.error || notice.error, notes: notice.note && !p.notes.includes(notice.note) ? [...p.notes, notice.note] : p.notes, tools: p.tools.map(t => t.status === 'running' ? { ...t, running: false, status: 'canceled' } : t) }))
        asmRef.current?.flushNow()
        finalize(pendingModelRef.current)
        break
      }
      case 'session_updated':
        // 后端已提交 JSONL；先更新侧栏的预览/时间/消息数。
        // 正文仍由 completed 收尾后刷新，避免实时 assistant 与服务端历史短暂双渲染。
        refreshSessions()
        break
      case 'completed':
        finalize(pendingModelRef.current)
        break
    }
    scroll()
  }

  const connectRun = (record: ActiveRunRecord) => {
    streamCloseRef.current?.()
    activeRunRef.current = record
    assistantMsgIdRef.current = record.assistantMessageId
    streamRef.current = record.stream
    setStream({ ...record.stream })
    // 断线恢复：把快照灌回组装器，游标之后的新事件在快照基础上继续累加（不重复、不丢段）
    makeAssembler()?.hydrate(record.stream)
    saveActiveRun(record)
    streamCloseRef.current = RunsApi.stream(
      record.runId,
      record.lastSeq,
      applyRunEvent,
      () => {
        lastEventAtRef.current = Date.now()
        updStream(p => ({ ...p, notes: p.notes.includes('连接中断，正在恢复…') ? p.notes : [...p.notes, '连接中断，正在恢复…'] }))
      },
    )
  }

  useEffect(() => {
    if (!currentSessionId) return
    let alive = true
    const restore = async () => {
      let record = loadActiveRun(currentSessionId)
      if (!record) {
        const overview = await RunApi.overview(currentSessionId)
        const active = overview.active.find(run => run.sessionId === currentSessionId)
        if (!alive || activeRunRef.current || !active) return
        record = { runId: active.id, sessionId: currentSessionId, status: 'running', lastSeq: 0, assistantMessageId: `run-${active.id}`, stream: emptyStream() }
      }
      const run = await RunsApi.get(record.runId)
      if (!alive) return
      if (isTerminalRunStatus(run.status) && run.lastSeq <= record.lastSeq) {
        activeRunRef.current = record
        assistantMsgIdRef.current = record.assistantMessageId
        streamRef.current = record.stream
        setStream({ ...record.stream })
        if (run.status !== 'completed') {
          const notice = run.status === 'interrupted' ? interruptionNotice(run) : { error: run.status === 'stopped' ? '已停止' : '任务执行失败' }
          updStream(p => ({ ...p, error: p.error || notice.error, notes: notice.note && !p.notes.includes(notice.note) ? [...p.notes, notice.note] : p.notes }))
        }
        finalize()
        return
      }
      connectRun({ ...record, status: run.status })
    }
    restore().catch(() => {
      if (alive) clearActiveRun(currentSessionId)
    })
    return () => { alive = false; streamCloseRef.current?.(); streamCloseRef.current = null }
  }, [currentSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const runCommand = async (cmd: string) => {
    if (cmd === '/new') {
      try { const d = await SessionsApi.create(); sessionIdRef.current = d.id; selectSession(d.id); void refreshSessions() } catch { toast('新建会话失败，请重试', 'error') }
      return
    }
    if (cmd === '/legacy') { window.location.href = '/?legacy=1'; return }
    const tips: Record<string, string> = {
      '/help': '可用命令：/new 新建会话 · /lx 记灵犀（如 /lx 加个时间轴视图） · /legacy 旧版界面 · /compact 压缩上下文（暂未接入） · /stats 统计（暂未接入）',
      '/compact': '/compact 暂未接入 React 版，可到旧版界面使用（/?legacy=1）',
      '/stats': '/stats 暂未接入 React 版，可到旧版界面使用（/?legacy=1）',
    }
    updateMessages(prev => [...prev, { id: 'sys' + Date.now(), role: 'system', text: tips[cmd] || `未知命令 ${cmd}`, ts: new Date().toISOString() }])
  }

  const send = async (raw: string, attachFiles: FileAttachment[] = []) => {
    const content = raw.trim(); if (!content || streamRef.current) return
    let sid = currentSessionId
    if (!sid) {
      // 尚无会话：先建会话并选中，等切会话的 effect 跑完（清流式态）再继续，
      // 否则乐观更新的用户消息会落空、后续 SSE 事件会被 effect 清掉
      try { const d = await SessionsApi.create(); sid = d.id; sessionIdRef.current = d.id; selectSession(d.id); void refreshSessions() } catch { return }
      await new Promise(r => setTimeout(r, 80))
    }
    // 灵犀速记：/lx 灵感内容 → 记入「我的灵感」，不进对话流、不发给模型
    if (content === '/lx' || content.startsWith('/lx ')) {
      const text = content.slice(3).trim()
      if (!text) { toast('用法：/lx 后面跟上灵感内容', 'error'); return }
      LingXiApi.add({ text, source: 'user' })
        .then(() => toast('✨ 已记入灵犀·我的灵感'))
        .catch(() => toast('灵犀记录失败', 'error'))
      return
    }
    // 用户消息防丢：引擎 agent.prompt 会自动把用户消息写入会话 JSONL（消息完成时 appendMessage），
    // 这里绝不能再手动预写一份到 JSONL——否则同一条 user 被写两份、parentId 相同，正是「重复+套旧答案」的根因。
    // 但前端自己的 IndexedDB 与服务端 JSONL 完全独立，写本地不会与引擎冲突，因此用 appendMessage 同时存本地。
    let userMsgId = 'u' + Date.now();
    try { localStorage.setItem('pi_pending_msg', JSON.stringify({ sid, content, at: Date.now() })) } catch {}
    appendMessage({ id: userMsgId, role: 'user', text: content, ts: new Date().toISOString() })
    assistantMsgIdRef.current = 'a' + (Date.now() + 1) // 本轮 assistant 消息固定 id，流式快照与最终写入用同一 id
    wasBackgroundRef.current = false // 新一轮开始，重置后台跟踪状态
    streamRef.current = emptyStream()
    setStream({ ...streamRef.current })
    makeAssembler()
    // 模型参数（ParamsPanel 存 localStorage，随请求带给 server）
    let params: { temperature?: number; top_p?: number } | undefined
    try { params = JSON.parse(localStorage.getItem('pi_params') || 'null') || undefined } catch {}
    try {
      const created = await RunsApi.create({
        sessionId: sid,
        clientRequestId: `web-${sid}-${userMsgId}`,
        message: content,
        model: currentModel === 'auto/auto' ? undefined : currentModel,
        files: attachFiles.length ? attachFiles : undefined,
        params,
      })
      const record: ActiveRunRecord = {
        runId: created.runId,
        sessionId: sid,
        lastSeq: created.lastSeq || 0,
        status: created.status,
        assistantMessageId: assistantMsgIdRef.current!,
        stream: streamRef.current || emptyStream(),
      }
      connectRun(record)
    } catch (error: any) {
      updStream(p => ({ ...p, error: error?.status === 409 ? '当前会话已有任务运行中' : friendlyStreamError(error?.message || '创建任务失败') }))
      finalize()
    }
    scroll()
  }

  // 失败重试（2026-09-16）：这一轮的 assistant 报错了，就把它前面最近那条用户消息重发一次。
  // 之前失败是"静默"的：记录被后端滤掉、界面什么都不显示，用户只能自己猜着重打一遍。
  const retryFailed = (m: ChatMessage) => {
    const i = messages.findIndex(x => x.id === m.id)
    for (let j = (i < 0 ? messages.length : i) - 1; j >= 0; j--) {
      const prev = messages[j]
      if (prev.role === 'user' && (prev.text || '').trim()) { void send(prev.text); return }
    }
  }

  const stop = async () => {
    const active = activeRunRef.current
    if (!active || active.status === 'stopping') return
    activeRunRef.current = { ...active, status: 'stopping' }
    saveActiveRun(activeRunRef.current)
    updStream(p => ({ ...p, notes: [...p.notes, '正在停止任务…'] }))
    try { await RunsApi.stop(active.runId) }
    catch (error: any) {
      updStream(p => ({ ...p, error: `停止失败：${error?.message || error}` }))
      activeRunRef.current = active
      saveActiveRun(active)
    }
  }

  const resumeRun = async (run: RunSummary) => {
    if (streamRef.current || !run?.id) return
    try {
      const resumed = await RunsApi.resume(run.id)
      const stream = emptyStream()
      const assistantMessageId = 'a' + (Date.now() + 1)
      assistantMsgIdRef.current = assistantMessageId
      streamRef.current = stream
      setStream({ ...stream })
      makeAssembler()
      connectRun({
        runId: run.id,
        sessionId: run.sessionId,
        lastSeq: resumed.lastSeq || 0,
        status: resumed.status,
        assistantMessageId,
        stream,
      })
    } catch (error: any) {
      toast(`继续任务失败：${error?.message || error}`, 'error')
    }
  }

  // 危险操作确认：后端弹 confirm 事件 → 用户点允许/拒绝 → 回传后端（resolve 审批 allow/reject）
  const answerConfirm = async (ok: boolean) => {
    const c = confirm
    setConfirm(null)
    if (!c || !c.id || !c.sessionId) return
    try { await ConfirmApi.answer(c.sessionId, c.id, ok) } catch { toast('确认回传失败，请重试', 'error') }
  }

  // SendBox 把转写文本填进输入框的回调通道；语音输入：录音 → /api/asr 转写 → 填入输入框
  const voiceTextRef = useRef<((t: string) => void) | null>(null)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const handleVoice = async (dataB64: string, format: string) => {
    setVoiceBusy(true)
    try {
      const d = await AsrApi.transcribe(dataB64, format)
      if (d.text) voiceTextRef.current?.(d.text)
      else throw new Error('未识别到内容')
    } catch (e: any) {
      updateMessages(prev => [...prev, { id: 'sysasr' + Date.now(), role: 'system', text: `语音识别失败：${e?.message || e}`, ts: new Date().toISOString() }])
    } finally { setVoiceBusy(false) }
  }

  // 首页：不做空洞欢迎卡，直接给高频任务入口。
  // ⚠️ 先 selectSession，再后台刷新列表：原先 `await refreshSessions()` 挡在 selectSession 前面，
  //    列表刷新一慢（会话多时 /api/sessions 要扫盘），currentSessionId 就有几秒是空的——
  //    这几秒里点附件上传就会不带 sessionId（服务端只能猜 → 卡片落到别的会话 → "传上去看不见"）。
  const newSession = async () => {
    try {
      const d = await SessionsApi.create()
      sessionIdRef.current = d.id
      selectSession(d.id)
      void refreshSessions()
    } catch { toast('新建会话失败，请重试', 'error') }
  }
  // 会话就绪兜底：state 还没落地时，上传/发送前问这里要一个真实 id（新建+选中后立刻返回）
  const ensureSessionId = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current
    if (currentSessionId) { sessionIdRef.current = currentSessionId; return currentSessionId }
    try {
      const d = await SessionsApi.create()
      sessionIdRef.current = d.id
      selectSession(d.id)
      void refreshSessions()
      return d.id
    } catch { return null }
  }, [currentSessionId, refreshSessions, selectSession])
  const openPanel = (p: string) => window.dispatchEvent(new CustomEvent('pi-open-panel', { detail: p }))
  const openWorkshop = (tab: 'image' | 'ppt') => {
    try { localStorage.setItem('pi_workshop_tab', tab) } catch {}
    location.hash = '#/workshop'
  }
  const welcomeActions = [
    { Icon: Plus, label: '新建对话', act: newSession },
    { Icon: ImagePlus, label: 'AI 绘画', act: () => openWorkshop('image') },
    { Icon: Presentation, label: '生成 PPT', act: () => openWorkshop('ppt') },
    { Icon: Clock4, label: '定时任务', act: () => { location.hash = '#/tasks' } },
    { Icon: Database, label: '会话管理', act: () => { location.hash = '#/sessiondb' } },
    { Icon: SquareTerminal, label: '终端', act: () => openPanel('terminal') },
  ]
  const welcome = (
    <div className="chat-welcome chat-workstart">
      <div className="chat-reading-column">
        <div className="workstart-identity">
          <img src="/static/branding/yuanshu-app-icon.png?v=desk" width="48" height="48" alt="" />
          <div><h1>元枢</h1><p>小语的工作空间</p></div>
        </div>
        <section className="workstart-actions" aria-labelledby="quick-actions-title">
          <div className="chat-section-head workstart-head">
            <h2 id="quick-actions-title">开始工作</h2>
            <button type="button" className="workstart-search" onClick={() => window.dispatchEvent(new Event('pi-open-palette'))} title="搜索命令"><Command className="w-4 h-4" />搜索</button>
          </div>
          <div className="workstart-command-grid">
            {welcomeActions.map(({ Icon, label, act }) => (
              <button type="button" key={label} onClick={act} className="workstart-command">
                <Icon className="w-[18px] h-[18px]" strokeWidth={1.8} />
                <span>{label}</span>
                <ChevronRight className="workstart-chevron w-4 h-4" strokeWidth={1.8} />
              </button>
            ))}
          </div>
        </section>

      </div>
    </div>
  )

  const idleWarned = idleSeconds * 1000 >= IDLE_WARN_MS && streaming

  // 情绪指示器：与工作台共用 emotion-live，SSE 写回同一份缓存
  const [agentStatus, setAgentStatus] = useState<'idle'|'busy'|'error'>('idle')
  // 后台执行探测：轮询服务端 busy 会话表——本页没在流式但后台/他端在跑也要亮灯（用户靠它判断小语是否在工作）
  const [remoteBusy, setRemoteBusy] = useState<'self' | 'other' | null>(null)
  useEffect(() => {
    let alive = true
    let failCount = 0
    const tick = async () => {
      try {
        const d = await AgentStatusApi.get()
        if (!alive) return
        failCount = 0
        const busy = d.busy || []
        if (!busy.length) setRemoteBusy(null)
        else if (currentSessionId && busy.some(b => b.id === currentSessionId)) setRemoteBusy('self')
        else setRemoteBusy('other')
      } catch {
        if (++failCount > 3 && alive) setRemoteBusy(null) // 连续失败按空闲显示，不误报
      }
    }
    tick()
    const t = setInterval(tick, 4000)
    return () => { alive = false; clearInterval(t) }
  }, [currentSessionId])

  // 派发状态：本地流式 / 后台任一会话在跑 → busy（红点脉动）；stream.error → error；其余 idle
  useEffect(() => {
    if (stream?.error) setAgentStatus('error')
    else if (stream || remoteBusy) setAgentStatus('busy')
    else setAgentStatus('idle')
  }, [stream, remoteBusy])
  // 安卓原生桥接：将全局忙/闲状态同步给桌面小组件（没有 YuanshuBridge 时（桌面/网页版）静默跳过）
  useEffect(() => {
    try { (window as any).YuanshuBridge?.setStatus?.(agentStatus) } catch {}
  }, [agentStatus])
  const busyFromBackground = !stream && remoteBusy === 'other'
  const currentSessionName = sessions.find(session => session.id === currentSessionId)?.name || '元枢会话'
  const exportSession = async (format: 'html' | 'jsonl') => {
    if (!currentSessionId || exportingFormat) return
    setExportOpen(false)
    setExportingFormat(format)
    try {
      const safeName = currentSessionName.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 64) || '元枢会话'
      await downloadApiFile(SessionsApi.export(currentSessionId, format), safeName + '.' + format)
      toast('会话已导出为 ' + format.toUpperCase(), 'ok')
    } catch (error: any) {
      toast('导出失败：' + (error?.message || '请稍后重试'), 'error')
    } finally {
      setExportingFormat(null)
    }
  }
  // 四色语义：绿=就绪 红=本页执行 橙=后台执行 品红闪=异常（看颜色一眼明白）
  const dotCls = agentStatus === 'busy' ? (busyFromBackground ? 'status-dot-bg' : 'status-dot-busy') : `status-dot-${agentStatus}`
  const liveCls = agentStatus === 'busy' ? (busyFromBackground ? 'status-pill-live-bg' : 'status-pill-live-busy') : agentStatus === 'error' ? 'status-pill-live-error' : ''

  return (
    <ChatMediaProvider key={currentSessionId || 'none'} sessionId={currentSessionId || ''} messages={[...normalMessages, ...(stream ? [stream] : draftMsg ? [draftMsg] : [])]}>
    <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
      {/* 下拉刷新指示器（移动端触屏；锚定头部下方，平时 opacity:0 不占位） */}
      <div aria-hidden
        className="pointer-events-none absolute z-[var(--pi-z-toast)] left-1/2 -translate-x-1/2 top-[52px] w-9 h-9 rounded-full border border-pi-border bg-pi-bg1 shadow-xl grid place-items-center"
        style={pull.indicatorStyle}>
        <RefreshCw className={`w-4 h-4 text-pi-dim ${pull.spin ? 'animate-spin' : ''}`} strokeWidth={2} />
      </div>
      {/* 顶栏：手机端 48px（原来 56px 加上状态栏显得顶部过高），≥640px 回到 56px */}
      <div className="flex items-center px-4 sm:px-5 h-12 sm:h-14 border-b border-pi-border bg-pi-bg1 flex-shrink-0 gap-2">
        <div className="font-medium text-[15px] text-pi-text min-w-0 truncate">{compactHeader ? personaLabel : '对话'}</div>
        <div className="ml-auto" />
        {/* 执行状态（对标老版 .status-pill；aria-live 让屏幕阅读器感知流式开始/结束）*/}
        <div role="status" aria-live="polite" className={`status-pill text-[11px] text-pi-dim flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-pi-bg2/50 ${liveCls}`}>
          <span className={`status-dot ${dotCls} w-[7px] h-[7px] rounded-full flex-shrink-0`} />
          <span>{agentStatus === 'busy' ? (busyFromBackground ? '后台执行中' : '执行中') : agentStatus === 'error' ? '异常' : '就绪'}</span>
        </div>
        {/* 右栏开关：紧贴状态胶囊（桌面端；原 fixed 悬浮层会遮挡头部） */}
        {onRightPanel && (
          <button
            aria-label="打开TUI终端" title="TUI 终端"
            onClick={() => { if (rightPanel !== 'chat') onRightPanel('chat'); onRightPanel('tui') }}
            className={`text-[11px] px-2.5 py-1 rounded-pi-sm border flex items-center gap-1 flex-shrink-0 transition-colors duration-150 ${
              rightPanel === 'tui'
                ? 'bg-pi-accent text-pi-on-accent border-pi-accent'
                : 'border-pi-border-soft bg-pi-bg2/60 text-pi-dim hover:text-pi-text'}`}
          >TUI</button>
        )}
        {onRightPanel && (
          <button
            aria-label="切换右栏"
            aria-pressed={rightPanel !== 'chat'}
            title={rightPanel !== 'chat' ? '收起右栏' : '打开右栏'}
            onClick={() => onRightPanel(rightPanel === 'chat' ? 'workspace' : 'chat')}
            className={`text-[11px] px-2.5 py-1 rounded-pi-sm border flex items-center gap-1 flex-shrink-0 transition-colors duration-150 ${
              rightPanel && rightPanel !== 'chat'
                ? 'bg-pi-accent text-pi-on-accent border-pi-accent'
                : 'border-pi-border-soft bg-pi-bg2/60 text-pi-dim hover:text-pi-text glow-hover'}`}
            >
            <PanelRight className="w-3 h-3" strokeWidth={2} />
            {rightPanel !== 'chat' ? RIGHT_PANEL_LABELS[rightPanel || 'workspace'] || '右栏' : '右栏'}
          </button>
        )}
        <div className="chat-export-wrap">
          <button
            type="button"
            className="chat-export-trigger"
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            aria-label="导出会话"
            title={currentSessionId ? '导出当前会话' : '请先选择会话'}
            disabled={!currentSessionId || !!exportingFormat}
            onClick={() => setExportOpen(open => !open)}
          >
            <Download className="w-3.5 h-3.5" strokeWidth={1.8} />
            <span className="hidden sm:inline">{exportingFormat ? '导出中…' : '导出'}</span>
            <ChevronDown className={'hidden sm:block w-3 h-3 transition-transform ' + (exportOpen ? 'rotate-180' : '')} />
          </button>
          {exportOpen && currentSessionId && (
            <div className="chat-export-menu" role="menu" aria-label="导出格式">
              <button type="button" role="menuitem" onClick={() => exportSession('html')} disabled={!!exportingFormat}>
                <FileText className="w-3.5 h-3.5" />网页归档 <span>.html</span>
              </button>
              <button type="button" role="menuitem" onClick={() => exportSession('jsonl')} disabled={!!exportingFormat}>
                <Code2 className="w-3.5 h-3.5" />原始记录 <span>.jsonl</span>
              </button>
            </div>
          )}
        </div>
        {/* 心情：服务端真实情绪镜像，只展示不可点改。灵珠连续反映 VAD（2026-09-03，替代 emoji 八桶） */}
        <div className={`emo-pill w-[30px] h-[30px] rounded-full flex items-center justify-center cursor-default transition-colors hover:bg-pi-bg2/40`}
          title={emoTooltip(emoState, emoMetaLive)}>
          <MoodOrb state={emoState} size={24} label={`小语情绪：${emoMetaLive.label}`} />
        </div>
      </div>

      {/* 无新事件只提示，不改变服务端任务状态 */}
      {idleWarned && (
        <div className="px-6 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-xs flex-shrink-0">
          ⏳ 已 {idleSeconds}s 无新事件——任务不会因息屏或断连自动停止；可稍候回来查看，执行状态以服务端为准。如需结束，请点「停止」
        </div>
      )}

      {/* 消息区 */}
      <div ref={(el) => { scrollRef.current = el; pull.containerRef.current = el }} className="chat-scroll-region flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="chat-reading-column w-full py-8 space-y-5" aria-label="加载中">
            {[520, 380, 460].map((w, i) => (
              <div key={i} className="flex gap-3" style={{ animationDelay: `${i * 0.08}s` }}>
                <div className="w-7 h-7 rounded-lg skeleton-block flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 rounded-pi-sm skeleton-block" style={{ width: `${w * 0.7}px`, maxWidth: '80%' }} />
                  <div className="h-3 rounded-pi-sm skeleton-block" style={{ width: `${w}px`, maxWidth: '92%' }} />
                  <div className="h-3 rounded-pi-sm skeleton-block" style={{ width: `${w * 0.55}px`, maxWidth: '65%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : messages.length === 0 && !stream && !draftMsg ? welcome
          : (
            <div className="chat-reading-column w-full py-4 sm:py-6">
              {msgData?.truncated && (
                <button
                  className="mb-3 w-full min-h-11 text-xs text-pi-dim hover:text-pi-text border border-pi-border-soft rounded-pi-md"
                  onClick={() => {
                    if (!currentSessionId) return
                    mutateMsgs(SessionsApi.messages(currentSessionId, { tail: 0, leafId: msgData.leafId }), { revalidate: false })
                  }}>
                  加载更早的对话{typeof msgData.total === 'number' ? `（共 ${msgData.total} 条）` : ''}
                </button>
              )}
              <TurnList
                messages={normalMessages}
                onRetry={retryFailed}
                streamingNode={stream ? (() => {
                  // 阶段分区渲染：工具前文字在上、结论在工具卡后（conclusion 存在即启用分区）；
                  // 错误信息拼在最后一块，避免重复展示
                  const errTail = stream.error ? `\n\n⚠️ ${friendlyStreamError(stream.error)}` : ''
                  const hasConclusion = !!stream.conclusion
                  const preToolText = hasConclusion ? stream.text.slice(0, Math.max(0, stream.text.length - stream.conclusion.length)) : stream.text
                  return <Message msg={{
                    id: '__streaming__', role: 'assistant',
                    text: hasConclusion ? preToolText : stream.text + errTail,
                    conclusion: hasConclusion ? stream.conclusion + errTail : undefined,
                    think: stream.think, tools: stream.tools, notes: stream.notes,
                    // ② 流式期间就带上主驾引擎，回复途中也能看见"这一轮谁在干活"
                    engine: stream.engine, engineReason: stream.engineReason,

                    switchedModel: stream.switchedModel,
                    model: stream.model,
                    requestedModel: stream.requestedModel,
                    files: stream.files, images: stream.images, audios: stream.audios, videos: stream.videos,
                    streaming: true,
                  }} />
                })() : draftMsg ? (
                  <div className="relative">
                    <div className="absolute -left-2 top-0 bottom-0 w-1 bg-amber-500/30 rounded-full" />
                    <div className="mb-2 flex items-center gap-2">
                      <div className="text-xs text-amber-400 font-medium">📝 未完成的回复（本地草稿，刷新不丢）</div>
                      <button
                        onClick={() => { deleteMessage(draftMsg!.id).then(() => setLocalMessages(prev => prev.filter(m => m.id !== draftMsg!.id))) }}
                        className="text-xs text-pi-dim hover:text-pi-text px-2 py-0.5 rounded border border-pi-border-soft hover:border-pi-border"
                      >丢弃</button>
                    </div>
                    <Message msg={draftMsg} />
                  </div>
                ) : undefined}
              />
            </div>
          )}
        <div className="chat-reading-column mx-auto w-full px-3 sm:px-4">
          <ChatRunStatus sessionId={currentSessionId} onStop={stop} onResume={resumeRun} />
        </div>
      </div>

      {/* 输入栏 */}
      {/* 危险操作确认浮层（dsh user-approval seam）：后端弹 confirm 事件时出现 */}
      {confirm && (
        <div className="absolute inset-0 z-[var(--pi-z-toast)] flex items-center justify-center p-4 pointer-events-none">
          <div className="pointer-events-auto max-w-sm w-full rounded-pi-xl bg-pi-bg1 border border-pi-red/30 shadow-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-pi-md bg-pi-red/15 text-pi-red flex items-center justify-center flex-shrink-0"><ShieldAlert className="w-4 h-4" /></div>
              <div>
                <div className="text-[13px] font-semibold text-pi-text">危险操作确认</div>
                <div className="text-[11px] text-pi-dim2 font-mono">{confirm.toolName || '工具'}</div>
              </div>
            </div>
            <div className="text-[12px] text-pi-dim leading-relaxed mb-3">{confirm.reason || '该操作需要你确认后才会执行。'}</div>
            {confirm.args?.command && (
              <pre className="bg-black/25 border border-pi-border-soft rounded-pi-md p-2.5 text-[11px] text-pi-dim font-mono whitespace-pre-wrap break-all max-h-28 overflow-auto mb-3">{confirm.args.command}</pre>
            )}
            <div className="flex gap-2">
              <button className="btn-tool text-xs flex-1" onClick={() => answerConfirm(false)}>拒绝</button>
              <button className="btn-primary text-xs flex-1 bg-pi-red/90 hover:bg-pi-red border-pi-red" onClick={() => answerConfirm(true)}>允许执行一次</button>
            </div>
          </div>
        </div>
      )}

      {/* 回到底部：用户上翻后出现（nomifun 同款交互） */}
      {!atBottom && (
        <button
          aria-label="回到底部"
          onClick={() => scroll(true)}
          className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-pi-border bg-pi-bg1 text-[12px] text-pi-dim hover:text-pi-text glow-hover shadow-xl transition-colors duration-200 touch-hit"
        >
          <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} />
          回到底部
        </button>
      )}
      <div className="mobile-composer border-t border-pi-border bg-pi-bg1 px-3 sm:px-4 py-2.5 flex-shrink-0">
        <div className="chat-reading-column mx-auto">
          <SendBox key={currentSessionId ?? 'none'} streaming={!!stream} onStop={stop} onSend={send} onCommand={runCommand}
            voiceBusy={voiceBusy} onVoice={handleVoice} onVoiceTextReady={fn => { voiceTextRef.current = fn }}
            sessionId={currentSessionId} ensureSession={ensureSessionId}
            onUploaded={(r) => {
              // 服务端说"这次是猜的"（只可能来自没带 sessionId 的调用方）→ 如实告诉用户卡片挂哪儿了，
              // 别让人对着"传上去了但看不见"发呆。
              if (r?.guessedSession) toast(`文件已挂到会话 ${String(r.attachedTo || '').slice(0, 8)}…（当前会话还没就绪），刷新会话列表可见`, 'error')
              else if (r?.attachedTo && r.attachedTo !== sessionIdRef.current) toast('文件挂到了别的会话，请刷新后重试', 'error')
              void mutateMsgs()
              void refreshSessions()
            }} />
        </div>
      </div>
          <XiaoyuWidget />
</div>
    </ChatMediaProvider>
  )
}
