import ThemedSelect from '../../components/ThemedSelect'
import { useState } from 'react'
import useSWR from 'swr'
import { StoryApi } from '../../api'
import type { StoryEpisode, StoryProject } from '../../types'

// 分集：短剧/系列内容的组织单位。
//
// 对照 PINNGOO（"小说转分集短剧"：按原著体量与单集时长规划集数、按集查看调整、生成前可改单集）
// 与 LibTV（按集拆镜头）时，这是我们此前完全没有的一层——做短剧时手里只有一堆平铺的场，
// 没有"第 3 集"这个概念，于是"这一集多长""这一集里有哪些场""这一集还差多少没生成"都答不上来。
//
// 边界：**允许"未分集"**（单集短片、临时草稿照旧能用）；**删集只解绑，不删场**。
export default function StoryEpisodes({ project, busy, onDone, onPickScene }: {
  project: StoryProject
  busy: boolean
  onDone: (project: StoryProject) => void
  onPickScene?: (sceneId: string) => void
}) {
  const { data, mutate } = useSWR(`story-episodes-${project.id}`, () => StoryApi.episodes(project.id), { revalidateOnFocus: false })
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const [title, setTitle] = useState('')
  const [target, setTarget] = useState('')
  const episodes: StoryEpisode[] = data?.episodes || []
  const groups = data?.groups || []

  const act = async (label: string, fn: () => Promise<string>) => {
    setMsg('')
    try { const m = await fn(); await mutate(); setMsg(m) } catch (e: any) { setMsg(e?.message || `${label}没成功`) }
  }
  const add = () => act('建集', async () => {
    const r = await StoryApi.addEpisode(project.id, { title: title.trim() || undefined, targetSeconds: Number(target) > 0 ? Number(target) : undefined })
    onDone(r.project); setTitle(''); setTarget('')
    return `已新建「${r.episode.title}」`
  })
  const save = (ep: StoryEpisode, patch: Partial<StoryEpisode>) => act('改集', async () => {
    const r = await StoryApi.updateEpisode(project.id, { episodeId: ep.id, ...patch })
    onDone(r.project); return '已保存'
  })
  const remove = (ep: StoryEpisode) => act('删集', async () => {
    const r = await StoryApi.removeEpisode(project.id, { episodeId: ep.id })
    onDone(r.project)
    return `已删除「${ep.title}」——里面的场回到「未分集」，一个都没丢`
  })
  const assign = (sceneId: string, episodeId: string) => act('指派', async () => {
    const r = await StoryApi.assignScene(project.id, { sceneId, episodeId: episodeId || undefined })
    onDone(r.project); return episodeId ? '已归到该集' : '已放回「未分集」'
  })

  return <div className="story-episodes">
    <div className="story-head">
      <span>分集 · {episodes.length ? `${episodes.length} 集` : '未分集'}{data?.unassigned ? `（${data.unassigned} 场未分集）` : ''}</span>
      <button className="btn-ghost" disabled={busy} onClick={() => setOpen(o => !o)}>{open ? '收起' : '分集'}</button>
    </div>
    {open && <div className="story-episodes-body">
      <p className="story-hint">短剧/系列按集组织：一集包含若干场。没归集的场留在「未分集」，不会被强行塞进某一集；删集只解绑，不删场。</p>
      <div className="story-episodes-add">
        <input aria-label="新集标题" value={title} disabled={busy} onChange={e => setTitle(e.target.value)} placeholder="新一集的标题（可留空，自动叫「第 N 集」）" />
        <input aria-label="单集目标时长" value={target} disabled={busy} onChange={e => setTarget(e.target.value.replace(/[^0-9]/g, ''))} placeholder="目标时长（秒，可留空）" />
        <button className="btn-ghost" disabled={busy} onClick={add}>新建一集</button>
      </div>
      {episodes.length > 0 && <ul className="story-episode-list">
        {episodes.map(ep => {
          const st = ep.stats
          return <li key={ep.id} className="story-episode-item">
            <div className="story-episode-head">
              <input aria-label={`第 ${ep.no} 集标题`} defaultValue={ep.title} disabled={busy}
                onBlur={e => { const v = e.target.value.trim(); if (v && v !== ep.title) void save(ep, { title: v }) }} />
              <span>{st ? `${st.scenes} 场 / ${st.beats} 段 · 已出 ${st.withOutput}${st.running ? ` · 排队 ${st.running}` : ''}${st.failed ? ` · 失败 ${st.failed}` : ''}` : ''}
                {ep.targetSeconds ? ` · 目标 ${ep.targetSeconds}s` : ''}</span>
              <button className="btn-ghost" disabled={busy} onClick={() => remove(ep)}>删除本集</button>
            </div>
            <textarea aria-label={`第 ${ep.no} 集梗概`} defaultValue={ep.summary} rows={2} disabled={busy}
              placeholder="这一集讲什么（写清冲突与钩子）"
              onBlur={e => { const v = e.target.value.trim(); if (v !== ep.summary) void save(ep, { summary: v }) }} />
          </li>
        })}
      </ul>}
      <div className="story-episode-groups">
        {groups.map((g, gi) => <div key={g.episode?.id || `loose-${gi}`} className="story-episode-group">
          <div className="story-episode-group-head">{g.episode ? `第 ${g.episode.no} 集 · ${g.episode.title}` : '未分集'}<span>{g.scenes.length} 场</span></div>
          <ul>{g.scenes.map(s => <li key={s.id}>
            <button className="story-link" onClick={() => onPickScene?.(s.id)}>{s.title || s.id}</button>
            <span>{s.beats} 段</span>
            <ThemedSelect aria-label={`${s.title || s.id} 归属`} disabled={busy} value={g.episode?.id || ''} onChange={e => assign(s.id, e.target.value)}>
              <option value="">未分集</option>
              {episodes.map(ep => <option key={ep.id} value={ep.id}>第 {ep.no} 集 · {ep.title}</option>)}
            </ThemedSelect>
          </li>)}</ul>
        </div>)}
      </div>
      {msg && <p role="status" className="story-notice">{msg}</p>}
    </div>}
  </div>
}
