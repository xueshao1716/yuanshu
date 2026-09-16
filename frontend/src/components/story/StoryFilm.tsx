import { useEffect, useState } from 'react'
import { StoryApi } from '../../api'
import type { StoryFilmPlan, StoryProject } from '../../types'
import StoryTimeline from './StoryTimeline'

// 合成成片时的**挑片段**：同一段常常生成过好几版镜头，只让"按分镜顺序自动拼"等于把选片子的权利拿走。
//
// 这一块要做对三件事：
// - 默认值就是原来的行为（每段取最新可用的一版、按分镜顺序），不改也能一键合成；
// - 每一段能换版本、能整段不要、能调顺序——顺序就是成片里的先后；
// - 挑不出来的（文件不在了、这一版被删了）**如实说明**，并把它排除掉，不能静默少一段。
//
// 这里只管**状态与动作**（picks / dropped / 合成），把"这支片子由哪几段、每段多长、用第几版"
// 的画法交给 StoryTimeline：那份清单既要能扫（一排缩略图），又要能改（展开换版本、单段导出），
// 塞回这个面板只会又变成一列下拉。
export default function StoryFilm({ project, busy, onDone, onNotice, onError }: {
  project: StoryProject
  busy: boolean
  onDone: (project: StoryProject) => void
  onNotice: (text: string) => void
  onError: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<StoryFilmPlan | null>(null)
  // 清单是哪个项目的：换项目时上一份还在手上，不认一下就会把别的项目的段落画进时间轴
  const [planFor, setPlanFor] = useState('')
  const [loading, setLoading] = useState(false)
  // picks：有序数组，顺序 = 成片里的顺序。value 是 runId，'' 表示这一段用默认（最新可用）
  const [picks, setPicks] = useState<{ beatId: string; runId: string }[]>([])
  const [dropped, setDropped] = useState<string[]>([])
  const [msg, setMsg] = useState('')

  const load = async () => {
    setLoading(true); setMsg('')
    try {
      // durations=1：时间轴要报"每段多长、合计多长"。没有时长数据就如实写"时长未知"，
      // 不能拿分镜里写的目标时长顶替——那是期望，不是这一版产物的实际长度。
      const p = await StoryApi.filmPlan(project.id, { durations: true })
      setPlan(p)
      setPlanFor(project.id)
      // 默认挑：每段推荐的那一版，按分镜顺序，只保留真有可用版本的段
      setPicks(p.beats.filter(b => b.recommendedRunId).map(b => ({ beatId: b.beatId, runId: b.recommendedRunId })))
      setDropped([])
    } catch (e: any) { setMsg(e?.message || '拿不到片段清单') } finally { setLoading(false) }
  }
  // 时间轴是"这支片子现在长什么样"的视图，打开页面就该看得见——不再等用户点开合成面板。
  useEffect(() => { void load() }, [project.id])

  // 换版本**不改变成片顺序**：原来在第几段就还在第几段。
  // （老的下拉是删掉再追加到末尾，用户调过顺序之后换个版本，那一段会悄悄跑到最后。）
  const pick = (beatId: string, runId: string) => setPicks(prev => {
    const at = prev.findIndex(p => p.beatId === beatId)
    const rest = prev.filter(p => p.beatId !== beatId)
    if (at < 0) return [...rest, { beatId, runId }]
    rest.splice(at, 0, { beatId, runId })
    return rest
  })
  const move = (i: number, delta: number) => setPicks(prev => {
    const next = [...prev]
    const j = i + delta
    if (j < 0 || j >= next.length) return prev
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })

  const assemble = async () => {
    if (!picks.length) { setMsg('一段都没选，先至少留一段。'); return }
    setLoading(true); setMsg('')
    try {
      const r = await StoryApi.film(project.id, { clips: picks })
      if (r.project) onDone(r.project)
      const skipped = r.skipped || []
      const localized = r.localized || []
      onNotice(`成片已生成：${r.clipCount} 段拼接完成${r.method === 'copy' ? '（只有一段，直接落盘）' : ''}，按你挑的版本与顺序。${localized.length ? ` 其中 ${localized.length} 段原本是外站临时链接，已先下载到本地再拼（并写回项目）。` : ''}${skipped.length ? ` 有 ${skipped.length} 段没拼进去：${skipped.map(s => s.reason).join('；')}` : ''}`)
      await load()
    } catch (e: any) { onError(e?.message || '合成失败') } finally { setLoading(false) }
  }

  return <div className="story-film">
    <div className="story-head">
      <span>合成成片{(plan?.usable && open) ? ` · 可拼 ${plan.usable}/${plan.total} 段` : ''}</span>
      <button className="btn-ghost" disabled={busy} onClick={() => setOpen(o => !o)}>{open ? '收起' : '挑片段合成'}</button>
    </div>
    {msg && <p role="status" className="story-notice">{msg}</p>}
    {loading && planFor !== project.id && <p className="story-hint">正在读可用的片段…</p>}
    {plan && planFor === project.id && <StoryTimeline
      plan={plan}
      picks={picks}
      dropped={dropped}
      busy={busy || loading}
      onPick={pick}
      onMove={move}
      onDrop={beatId => {
        setDropped(prev => prev.includes(beatId) ? prev : [...prev, beatId])
        setPicks(prev => prev.filter(p => p.beatId !== beatId))
      }}
      onRestore={beatId => {
        setDropped(prev => prev.filter(id => id !== beatId))
        setPicks(prev => prev.some(p => p.beatId === beatId) ? prev : [...prev, {
          beatId,
          runId: plan.beats.find(b => b.beatId === beatId)?.recommendedRunId || '',
        }])
      }}
    />}
    {open && plan && planFor === project.id && <div className="story-film-body">
      <p className="story-hint">
        <strong>默认就是原来那套</strong>（每段用最新可用的一版、按分镜顺序）——改了才按你的来。
        上面时间轴的顺序就是成片里的先后。
        外站临时链接的片段会<strong>先下载到本地再拼</strong>（并写回项目），不用你手动处理。
      </p>
      <div className="story-actions">
        <button className="btn-primary" disabled={busy || loading || !picks.length} onClick={assemble}>
          {loading ? '合成中…' : `按这个顺序合成（${picks.length} 段）`}
        </button>
        <button className="btn-ghost" disabled={busy || loading} onClick={() => void load()}>重置成默认</button>
        <button className="btn-ghost" disabled={busy || loading} onClick={() => setPicks(prev => [...prev].reverse())}>整体倒序</button>
      </div>
      {project.films?.length ? <p className="story-hint">成片历史里有 {project.films.length} 版；这一版会记下用了哪几段的哪一版，可以在「作品」里对着看。</p> : null}
    </div>}
  </div>
}
