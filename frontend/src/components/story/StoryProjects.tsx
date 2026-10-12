import ThemedSelect from '../../components/ThemedSelect'
import { useState } from 'react'
import { StoryApi } from '../../api'
import type { StoryProject } from '../../types'

// 项目架：把「选项目」从一个下拉框换成一份列表。
//
// 为什么换掉下拉框：项目一多，`<ThemedSelect>` 里只看得见标题——哪个是上周的、哪个有成片、
// 哪个是随手建的草稿，全看不出来；更不能删。用户的原话是"或者项目那款不用下拉框了"。
// 这里每个项目一行：标题 + 场/段/成片 + 最近改动时间，行内就能打开或删除。
//
// 三条刻意的取舍：
// - **不自动切换**：点「打开」才切换，免得正在写的一段被顺手换掉；
// - **删除要确认**（不可逆）：确认块里说清会删掉什么，并给「连产物文件一起删」的选项（默认不勾）；
// - **默认保文件**：产物还在工作区里能从「资产」找到；项目本身也留一份副本在 `.trash/`。
export default function StoryProjects({ projects, currentId, busy, onOpen, onNew, onRefresh, onDone, onNotice, onError }: {
  projects: StoryProject[]
  currentId?: string
  busy: boolean
  onOpen: (project: StoryProject) => void
  onNew: () => void
  onRefresh: () => void
  onDone: (deletedId: string) => void
  onNotice: (text: string) => void
  onError: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState('')
  const [withFiles, setWithFiles] = useState(false)
  const [working, setWorking] = useState('')
  const current = projects.find(p => p.id === currentId)

  const remove = async (project: StoryProject) => {
    setWorking(project.id)
    try {
      const r = await StoryApi.deleteProject(project.id, withFiles ? { deleteFiles: true } : {})
      setConfirming('')
      onDone(project.id)
      const kept = (r.files || []).filter(f => !f.deleted && f.reason)
      onNotice(`已删除「${r.title}」。${withFiles ? `产物文件：清掉 ${r.fileDeleted} 个${kept.length ? `，保留 ${kept.length} 个（${kept.map(f => f.reason).join('；')}）` : ''}。` : '产物文件没动，还在工作区里。'}副本留在 story-projects/.trash/，改回来即可恢复。`)
    } catch (e: any) { onError(e?.message || '删除项目失败') } finally { setWorking('') }
  }

  const stats = (p: StoryProject) => {
    const beats = (p.scenes || []).reduce((n, s) => n + (s.beats || []).length, 0)
    const films = (p.films || []).length
    const eps = (p.episodes || []).length
    return `${(p.scenes || []).length} 场 / ${beats} 段${eps ? ` / ${eps} 集` : ''}${films ? ` / 成片 ${films}` : ''}`
  }

  return <div className="story-projects">
    <div className="story-head">
      <span>项目{projects.length ? ` · 共 ${projects.length} 个` : ''}{current ? ` · 当前「${current.title}」` : ''}</span>
      <button className="btn-ghost" disabled={busy} onClick={() => { setOpen(o => !o); if (!open) onRefresh() }}>{open ? '收起' : '项目'}</button>
    </div>
    {open && <div className="story-projects-body">
      <div className="story-projects-bar">
        <button className="btn-primary" disabled={busy} onClick={onNew}>新故事</button>
        <button className="btn-ghost" disabled={busy} onClick={onRefresh}>刷新</button>
        <span className="story-hint">点「打开」才切换当前项目（不会因为你翻列表就换掉正在写的东西）。</span>
      </div>
      {!projects.length && <p className="story-hint">还没有项目。点「新故事」写一句想法就能开始。</p>}
      <ul className="story-project-list">
        {projects.map(p => <li key={p.id} className={`story-project-item${p.id === currentId ? ' is-current' : ''}`}>
          <div className="story-project-main">
            <strong>{p.title}</strong>
            <span>{stats(p)}</span>
            <span>改动于 {new Date(p.updatedAt).toLocaleString('zh-CN')}</span>
            {p.id === currentId && <span className="story-project-badge">当前</span>}
          </div>
          {p.logline && <p className="story-project-logline">{String(p.logline).slice(0, 120)}</p>}
          <div className="story-actions">
            {p.id !== currentId && <button className="btn-ghost" disabled={busy} onClick={() => { onOpen(p); setOpen(false) }}>打开</button>}
            {confirming !== p.id && <button className="btn-ghost" disabled={busy || working === p.id} onClick={() => { setConfirming(p.id); setWithFiles(false) }}>删除</button>}
          </div>
          {confirming === p.id && <div className="story-confirm" role="alertdialog" aria-label={`确认删除项目 ${p.title}`}>
            <p>要删掉整个项目<strong>「{p.title}」</strong>（{stats(p)}）。这是不可逆的操作。</p>
            <label><input type="checkbox" checked={withFiles} disabled={busy} onChange={e => setWithFiles(e.target.checked)} /> 连产物文件一起删（只删没有被别的项目引用的）</label>
            <p className="story-hint">{withFiles ? '没被别处引用的产物文件会被删除；还被引用的会保留并告诉你原因。' : '产物文件会留着——工作区里还能从「资产」找到它们。'}项目本身会留一份副本在 <code>story-projects/.trash/</code>，改回来即可恢复。</p>
            <div className="story-actions">
              <button className="btn-primary" disabled={busy || working === p.id} onClick={() => remove(p)}>{working === p.id ? '删除中…' : '确认删除'}</button>
              <button className="btn-ghost" disabled={busy || working === p.id} onClick={() => setConfirming('')}>取消</button>
            </div>
          </div>}
        </li>)}
      </ul>
    </div>}
  </div>
}
