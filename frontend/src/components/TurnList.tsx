import { useMemo, useState } from 'react'
import { Wrench, Package, ChevronRight, ListFilter } from 'lucide-react'
import Message from './Message'
import { dayLabel, sameDayStr } from '../lib/fmt-time'
import type { ChatMessage } from '../types'

// ── 轮次折叠（turnDisclosure，对齐 NomiFun 交互）──
// 一轮 = 一条用户消息 + 其后所有 assistant/system 消息；
// 默认只展开最后一轮，历史轮折叠成一行摘要（问题节选 + 工具/产物统计），点击展开。
interface Turn {
  key: string
  user?: ChatMessage
  rest: ChatMessage[]
}

export function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === 'user' || turns.length === 0) {
      turns.push({ key: m.id || 't' + turns.length, user: m.role === 'user' ? m : undefined, rest: m.role === 'user' ? [] : [m] })
    } else {
      turns[turns.length - 1].rest.push(m)
    }
  }
  return turns
}

// 摘要统计：工具调用数 / 产物（文件+图片+音频）数
function turnStats(turn: Turn) {
  let tools = 0, artifacts = 0
  for (const m of turn.rest) {
    tools += m.tools?.length || 0
    artifacts += (m.files?.length || 0) + (m.images?.length || 0) + (m.audios?.length || 0) + (m.videos?.length || 0)
  }
  return { tools, artifacts }
}

const excerpt = (s: string, n = 64) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function TurnRow({ turn, index, open, onToggle, onRetry }: { turn: Turn; index: number; open: boolean; onToggle: () => void; onRetry?: (msg: ChatMessage) => void }) {
  const { tools, artifacts } = turnStats(turn)
  const q = turn.user ? excerpt(turn.user.text || '(附件消息)') : '(系统提示)'
  const answer = turn.rest.find(m => m.role === 'assistant')
  const aExcerpt = answer?.text ? excerpt(answer.text, 80) : ''
  // 轮次状态：本轮失败（assistant.error）/有工具报错→红 / 有回复→绿 / 无回复（被打断）→灰
  // 2026-09-16：assistant.error 是 pi 通道失败留下的记录，以前完全没进这个判断，
  // 于是失败的一轮在折叠列表里看着跟"已完成"一样。
  const assistantError = turn.rest.find(m => m.error)
  const hasToolError = turn.rest.some(m => m.tools?.some(t => t.isError))
  const status = assistantError
    ? { c: 'bg-pi-red', t: `本轮失败：${assistantError.error}` }
    : hasToolError ? { c: 'bg-pi-red', t: '有工具报错' }
    : answer ? { c: 'bg-emerald-400', t: '已完成' } : { c: 'bg-pi-dim2', t: '无回复' }
  return (
    <div className="turn-history-row">
      <button onClick={onToggle}
        className="turn-history-button press w-full flex items-center gap-2 text-left group/turn">
        <span className={`turn-history-status ${status.c}`} title={status.t} />
        <span className="text-[10px] font-mono text-pi-dim2 w-7 flex-shrink-0">#{index + 1}</span>
        <span className="text-[13px] text-pi-dim truncate flex-1 min-w-0">
          <span className="text-pi-text/85">{q}</span>
          {aExcerpt && <span className="text-pi-dim"> <span className="text-pi-accent2/60">→</span> {aExcerpt}</span>}
        </span>
        <span className="flex items-center gap-1.5 flex-shrink-0 text-[10px] text-pi-dim2">
          {/* 失败在折叠状态下也要看得见（2026-09-16）：不然"本轮失败"要展开才知道 */}
          {assistantError && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-pi-pill bg-pi-danger/15 text-pi-danger font-medium"
              title={`本轮失败：${assistantError.error}`}>⚠️ 本轮失败</span>
          )}
          {tools > 0 && <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-pi-pill bg-white/[0.04]" title={`${tools} 次工具调用`}><Wrench className="w-3 h-3" />{tools}</span>}
          {artifacts > 0 && <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-pi-pill bg-white/[0.04]" title={`${artifacts} 个产物`}><Package className="w-3 h-3" />{artifacts}</span>}
          {turn.user?.ts && <span className="hidden sm:inline">{new Date(turn.user.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>}
          <ChevronRight className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        </span>
      </button>
      {open && (
        <div className="turn-expanded-content">
          {turn.user && <Message msg={turn.user} />}
          {turn.rest.map(m => <Message key={m.id} msg={m} onRetry={onRetry} />)}
        </div>
      )}
    </div>
  )
}

interface TurnListProps {
  messages: ChatMessage[]
  // 流式中的实时消息（始终展开，属于最后一轮）
  streamingNode?: React.ReactNode
  // 默认展开最近几轮（其余折叠）
  keepExpanded?: number
  // 失败重试：把这一轮的用户消息重发一次（2026-09-16）
  onRetry?: (msg: ChatMessage) => void
}

export default function TurnList({ messages, streamingNode, keepExpanded = 1, onRetry }: TurnListProps) {
  const turns = useMemo(() => groupTurns(messages), [messages])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)

  // 折叠规则：showAll → 全开；否则最后 keepExpanded 轮 + 手动展开的
  const lastKeys = new Set(turns.slice(-keepExpanded).map(t => t.key))
  const isOpen = (t: Turn, i: number) => showAll || lastKeys.has(t.key) || expanded.has(t.key)
  const collapsedCount = turns.filter(t => !lastKeys.has(t.key) && !expanded.has(t.key)).length

  return (
    <div className="chat-turn-list">
      {!showAll && collapsedCount > 0 && (
        <div className="chat-history-head">
          <span><ListFilter className="w-3.5 h-3.5" /> 已收起较早的 {collapsedCount} 轮</span>
          <button onClick={() => setShowAll(true)}>展开全部 {turns.length} 轮</button>
        </div>
      )}
      {showAll && turns.length > keepExpanded && (
        <div className="chat-history-head">
          <span><ListFilter className="w-3.5 h-3.5" /> 正在显示全部 {turns.length} 轮</span>
          <button onClick={() => { setShowAll(false); setExpanded(new Set()) }}>收起较早轮次</button>
        </div>
      )}
      {turns.map((t, i) => {
        // 跨自然日插入日期分隔条（2026-09-04，修"只显几点没几日"坑）：取本轮首条消息时间与前轮比对
        const tTs = t.user?.ts ?? t.rest[0]?.ts
        const prevTs = i > 0 ? (turns[i - 1].user?.ts ?? turns[i - 1].rest[0]?.ts) : undefined
        const showDay = tTs != null && !sameDayStr(prevTs, tTs)
        return (
          <div key={t.key}>
            {showDay && (
              <div className="chat-day-divider" role="separator" aria-label={dayLabel(tTs)}>
                <span className="chat-day-divider-line" />
                <span className="chat-day-divider-text">{dayLabel(tTs)}</span>
                <span className="chat-day-divider-line" />
              </div>
            )}
            <TurnRow turn={t} index={i} open={isOpen(t, i)} onRetry={onRetry}
              onToggle={() => setExpanded(prev => {
                const next = new Set(prev)
                if (lastKeys.has(t.key)) return next // 最后一轮默认展开，不折叠
                next.has(t.key) ? next.delete(t.key) : next.add(t.key)
                return next
              })} />
          </div>
        )
      })}
      {streamingNode}
    </div>
  )
}
