import { ArrowUpRight, Package, Activity } from 'lucide-react'
import { withFileToken, type RunSummary, type TimeTask, type SubagentRun } from '../../api'
import type { AssetDelivery } from '../../types'

const phaseNames: Record<string, string> = { queued: '排队中', thinking: '思考中', executing: '执行中', remembering: '整理记忆', delivering: '交付中' }
export default function BoardFocus({ runs, tasks, agents, deliveries, runLoaded, deliveryLoaded, runError, deliveryError, onSession, onTeam }: {
  runs: RunSummary[]; tasks: TimeTask[]; agents: SubagentRun[]; deliveries: AssetDelivery[]
  runLoaded: boolean; deliveryLoaded: boolean; runError?: unknown; deliveryError?: unknown
  onSession: (id: string) => void; onTeam: () => void
}) {
  const count = runs.length + tasks.length + agents.length
  return <div className="board-focus-grid">
    <section className="board-focus" aria-labelledby="board-running-title">
      <header><h2 id="board-running-title"><Activity size={17} aria-hidden="true" />正在执行</h2><a href="#/tasks">任务安排<ArrowUpRight size={15} aria-hidden="true" /></a></header>
      {runError ? <p role="alert" className="board-notice">部分运行状态无法更新{count ? '，以下为上次读取的状态。' : '，暂时无法确认是否有任务运行。'}</p>
        : !runLoaded ? <p role="status" className="board-notice">正在读取运行状态…</p>
          : !count ? <div className="board-empty"><span className="board-idle-dot" />当前没有正在执行的任务<p>开始对话或创作后，可在这里查看进展。</p></div> : null}
      {runs.map(r => <button type="button" key={`chat-${r.id}`} className="board-row" disabled={!r.sessionId} onClick={() => onSession(r.sessionId)}><span className="board-running-dot" /><span><strong>{r.messagePreview || '会话任务'}</strong><small>{phaseNames[r.phase] || '处理中'} · 会话</small></span><ArrowUpRight size={16} aria-hidden="true" /></button>)}
      {tasks.map(t => <a href="#/tasks" key={`task-${t.id}`} className="board-row"><span className="board-running-dot" /><span><strong>{t.label || t.prompt}</strong><small>执行中 · 定时任务</small></span><ArrowUpRight size={16} aria-hidden="true" /></a>)}
      {agents.map(a => <button type="button" key={`agent-${a.id}`} className="board-row" onClick={onTeam}><span className="board-running-dot" /><span><strong>{a.task || a.agent}</strong><small>{a.state === 'waiting' ? '等待中' : '执行中'} · {a.agent}</small></span><ArrowUpRight size={16} aria-hidden="true" /></button>)}
    </section>
    <section className="board-focus" aria-labelledby="board-delivery-title">
      <header><h2 id="board-delivery-title"><Package size={17} aria-hidden="true" />最近交付</h2><a href="#/assets">全部作品<ArrowUpRight size={15} aria-hidden="true" /></a></header>
      {deliveryError ? <p role="alert" className="board-notice">交付记录无法更新{deliveries.length ? '，以下为上次读取的记录。' : '，请稍后再试。'}</p>
        : !deliveryLoaded ? <p role="status" className="board-notice">正在读取交付记录…</p>
          : !deliveries.length ? <div className="board-empty">还没有交付作品<p>在对话中完成并交付的文件，会出现在这里。</p><a href="#/workshop">去创作<ArrowUpRight size={15} aria-hidden="true" /></a></div> : null}
      {deliveries.slice(0, 4).map(d => {
        const path = d.openPath || (d.type === 'file' ? d.wsPath : '')
        return <a className="board-row" key={d.wsPath || d.name} href={path ? withFileToken(`/api/ws/file?path=${encodeURIComponent(path)}`) : '#/assets'} {...(path ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
          <Package size={17} aria-hidden="true" /><span><strong>{d.name}</strong><small>{d.mtime ? d.mtime.slice(5, 16).replace('T', ' ') : '未记录交付时间'} · {path ? '打开文件' : '在资产页查看'}</small></span><ArrowUpRight size={16} aria-hidden="true" />
        </a>
      })}
    </section>
  </div>
}
