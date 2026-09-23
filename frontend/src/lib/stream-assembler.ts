import { upsertRunningTool } from './chat-stream.ts'
import type { RunningTool } from '../types'

/**
 * stream-assembler —— 流式组装器（2026-09-02 从旧版 vanilla chat.js 移植恢复）
 *
 * 旧版机制（public-backup-20260901/js/chat.js :793-841）：
 *  1. delta/think 先进缓冲，~16ms 合帧刷新一次，避免高频 setState 卡死渲染；
 *  2. 工具开始后，后续文字进入「结论区」，不再混在工具卡前面的过程文字里；
 *  3. done/error/息屏恢复时强制 flushNow() 清空缓冲；
 *  4. toolCallId 幂等，断线重放不重复。
 *
 * 与旧版差异：React 版状态字段实时累加（ref 单一事实源），缓冲只控制
 * onFlush 回调节奏；text 恒为完整逻辑文本（preToolText + conclusion），
 * 供持久化、输出守卫与快照使用，渲染分区不丢内容。
 */

export interface AssemblerSnapshot {
  /** 工具开始前的过程文字 */
  preToolText: string
  /** 工具开始后的结论文字（渲染在工具卡之后） */
  conclusion: string
  /** 完整逻辑文本 = preToolText + conclusion（持久化/守卫用，不受渲染缓冲影响） */
  text: string
  think: string
  thinkDone: boolean
  tools: RunningTool[]
}

export interface ToolStartInput {
  id: string
  name?: string
  args?: unknown
}

interface AssemblerOptions {
  /** 合帧窗口，默认 16ms（≈1 帧）；测试可调大后手动 flushNow */
  flushDelayMs?: number
}

export class StreamAssembler {
  private preToolText = ''
  private conclusion = ''
  private think = ''
  private thinkDone = true
  private tools: RunningTool[] = []
  private toolStarted = false
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly flushDelayMs: number
  private disposed = false
  private onFlush: (snap: AssemblerSnapshot) => void

  constructor(onFlush: (snap: AssemblerSnapshot) => void, options: AssemblerOptions = {}) {
    this.onFlush = onFlush
    this.flushDelayMs = options.flushDelayMs ?? 16
  }

  /** 模型增量文字：按阶段分流（工具前 → 过程区；工具后 → 结论区） */
  addDelta(text: string) {
    if (this.disposed || !text) return
    if (this.toolStarted) this.conclusion += text
    else this.preToolText += text
    this.scheduleFlush()
  }

  /** 思考增量 */
  replaceResponse(text: string, think = '') {
    if (this.disposed) return
    this.preToolText = this.toolStarted ? '' : text
    this.conclusion = this.toolStarted ? text : ''
    this.think = think
    this.thinkDone = true
    this.dirty = true
    this.flushNow()
  }

  addThink(text: string) {
    if (this.disposed || !text) return
    this.think += text
    this.thinkDone = false
    this.scheduleFlush()
  }

  /** 思考结束：立即 flush，让 UI 马上收起思考块 */
  endThink() {
    if (this.disposed) return
    this.thinkDone = true
    this.dirty = true
    this.flushNow()
  }

  /** 工具开始：toolCallId 幂等（重复 start 更新原卡，不新增、不清空输出） */
  toolStart(input: ToolStartInput) {
    if (this.disposed || !input?.id) return
    const existing = this.tools.find(t => t.id === input.id)
    this.tools = upsertRunningTool(this.tools, input)
    if (!existing) this.toolStarted = true
    this.dirty = true
    this.flushNow()
  }

  /** 工具输出增量（覆盖语义由调用方决定，这里做拼接） */
  toolOutput(id: string, text: string) {
    if (this.disposed || !id) return
    this.tools = this.tools.map(t => t.id === id ? { ...t, output: t.output + (text || '') } : t)
    this.scheduleFlush()
  }

  /** 工具结束：终态写入并立即 flush（工具卡状态变化必须马上可见） */
  toolEnd(id: string, isError: boolean, output?: string) {
    if (this.disposed || !id) return
    this.tools = this.tools.map(t => t.id === id
      ? { ...t, running: false, isError: !!isError, status: isError ? 'error' as const : 'completed' as const, ...(output ? { output } : {}) }
      : t)
    this.dirty = true
    this.flushNow()
  }

  /** 立即清空缓冲并回调最新快照；缓冲为空时不重复触发 */
  flushNow() {
    if (this.disposed) return
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (!this.dirty) return
    this.dirty = false
    this.onFlush(this.snapshot())
  }

  private scheduleFlush() {
    if (this.disposed) return
    this.dirty = true
    this.scheduleTimer()
  }

  private scheduleTimer() {
    if (this.flushTimer || this.disposed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
    }, this.flushDelayMs)
  }

  /** 完整状态快照：text 恒为完整逻辑文本，渲染分区不丢内容 */
  snapshot(): AssemblerSnapshot {
    return {
      preToolText: this.preToolText,
      conclusion: this.conclusion,
      text: this.preToolText + this.conclusion,
      think: this.think,
      thinkDone: this.thinkDone,
      tools: [...this.tools],
    }
  }

  /** 断线恢复：从持久化快照重建内部状态，之后的新事件在快照基础上继续累加 */
  hydrate(snap: { text?: string; conclusion?: string; think?: string; thinkDone?: boolean; tools?: RunningTool[] }) {
    if (this.disposed) return
    const conclusion = snap.conclusion ?? ''
    const text = snap.text ?? ''
    this.conclusion = conclusion
    // text 恒为 preToolText + conclusion，故 preToolText 取 text 去掉尾部结论段；旧快照无 conclusion 时全量归过程区
    this.preToolText = conclusion ? text.slice(0, Math.max(0, text.length - conclusion.length)) : text
    this.think = snap.think ?? ''
    this.thinkDone = snap.thinkDone ?? true
    this.tools = (snap.tools ?? []).map(t => ({ ...t }))
    this.toolStarted = this.tools.length > 0
    this.dirty = false
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
  }

  dispose() {
    this.disposed = true
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
  }
}
