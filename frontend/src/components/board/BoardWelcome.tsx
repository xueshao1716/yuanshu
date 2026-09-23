import { ArrowRight, Plus, Sparkles, ListTodo, Users, Settings2 } from 'lucide-react'
import type { Session } from '../../types'

export default function BoardWelcome({ session, loaded, error, onContinue, onNew }: {
  session: Session | null; loaded: boolean; error?: unknown
  onContinue: () => void; onNew: () => void
}) {
  return <section className="board-welcome" aria-labelledby="board-welcome-title">
    <div className="board-welcome-copy">
      <h2 id="board-welcome-title">从这里，接着往前。</h2>
      <p className="board-intro">继续手头的事，也给下一个想法留点空间。</p>
      <div className="board-resume">
        <span className="board-label">最近会话</span>
        {error && <p role="alert">会话暂时无法更新{session ? '，以下为上次读取的记录。' : '，仍可开始新对话。'}</p>}
        {session ? <>
          <h3>{session.name || '未命名会话'}</h3>
          <p className="board-preview">{session.preview || '打开会话，继续之前的工作。'}</p>
        </> : <p>{loaded ? '还没有会话，从一个想法开始。' : error ? '暂时没有可显示的会话。' : '正在读取最近会话…'}</p>}
      </div>
      <div className="board-actions">
        {session && <button className="board-primary" type="button" onClick={onContinue}>继续会话<ArrowRight size={17} aria-hidden="true" /></button>}
        <button className={session ? 'board-secondary' : 'board-primary'} type="button" onClick={onNew}><Plus size={17} aria-hidden="true" />新建对话</button>
      </div>
    </div>
  </section>
}

export function BoardShortcuts({ onTeam }: { onTeam: () => void }) {
  return <nav className="board-shortcuts" data-slot="board-next" aria-label="工作台快捷入口">
      <h3>接下来做什么</h3>
      <a href="#/workshop"><Sparkles aria-hidden="true" /><span>去创作<small>把想法做成作品</small></span><ArrowRight aria-hidden="true" /></a>
      <a href="#/tasks"><ListTodo aria-hidden="true" /><span>去任务<small>安排与查看定时工作</small></span><ArrowRight aria-hidden="true" /></a>
      <button type="button" onClick={onTeam}><Users aria-hidden="true" /><span>天团协作<small>查看角色与协作记录</small></span><ArrowRight aria-hidden="true" /></button>
      <a href="#/models"><Settings2 aria-hidden="true" /><span>模型配置<small>管理接入与模型选择</small></span><ArrowRight aria-hidden="true" /></a>
    </nav>
}
