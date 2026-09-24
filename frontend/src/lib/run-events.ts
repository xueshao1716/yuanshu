export type RunStatus = 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export interface RunEvent {
  v?: number
  runId: string
  sessionId?: string
  seq: number
  type: string
  ts?: string
  data: any
}

export interface RunCursor {
  runId: string
  lastSeq: number
  status: RunStatus
}

const TERMINAL = new Set<RunStatus>(['completed', 'failed', 'stopped', 'interrupted'])

export function advanceRunCursor(cursor: RunCursor, event: RunEvent): {
  cursor: RunCursor
  accepted: boolean
  terminal: boolean
} {
  if (event.runId !== cursor.runId || !Number.isInteger(event.seq) || event.seq <= cursor.lastSeq) {
    return { cursor, accepted: false, terminal: TERMINAL.has(cursor.status) }
  }
  const status = TERMINAL.has(event.type as RunStatus)
    ? event.type as RunStatus
    : cursor.status
  const next = { ...cursor, lastSeq: event.seq, status }
  return { cursor: next, accepted: true, terminal: TERMINAL.has(status) }
}

export function parseSseBlocks(input: string): { events: RunEvent[]; rest: string } {
  const normalized = input.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const rest = blocks.pop() || ''
  const events: RunEvent[] = []
  for (const block of blocks) {
    if (!block || block.startsWith(':')) continue
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) continue
    try {
      const event = JSON.parse(dataLines.join('\n'))
      if (event && Number.isInteger(event.seq) && event.runId) events.push(event)
    } catch {}
  }
  return { events, rest }
}

export function isTerminalRunStatus(status: string): status is RunStatus {
  return TERMINAL.has(status as RunStatus)
}

export function interruptionNotice(data: { reason?: string; pauseReason?: string; message?: string; pauseMessage?: string }): { note?: string; error?: string } {
  const reason = data.reason || data.pauseReason
  if (['execution_budget', 'tool_turn_limit', 'progress_boundary', 'recovery_blocked'].includes(reason || '')) {
    return { note: data.message || data.pauseMessage || '任务已暂停，已保留进度；点击“继续任务”可接续。' }
  }
  return { error: reason === 'server_restarted' || !reason ? '服务重启，任务已中断' : '任务已中断，请查看运行记录。' }
}
