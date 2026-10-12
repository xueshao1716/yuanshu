import ThemedSelect from '../../components/ThemedSelect'
import { useState } from 'react'
import useSWR from 'swr'
import { StoryApi, downloadApiFile } from '../../api'
import type { StoryProject } from '../../types'

// 剧本：要素统计 + 导出 + 与角色对台词。
//
// 这一块对着 Laper（laper.ai）补的是它整个产品的地基——**剧本要素与导出**。
// 元枢此前能出图、出片、出正文，却拿不出一个能给人看的剧本文件。
// Playground 也是照它补的：拿一段台词去"试"，看角色会不会这么说话。
export default function StoryScript({ project, busy, onPatchProject }: {
  project: StoryProject
  busy: boolean
  onPatchProject?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState('txt')
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const { data: stats, mutate } = useSWR(open ? `story-script-stats-${project.id}` : null, () => StoryApi.scriptStats(project.id), { revalidateOnFocus: false })

  const exportIt = async () => {
    setSaving(true); setMsg('')
    try {
      const r = await StoryApi.exportScript(project.id, { format })
      const blob = new Blob([r.body], { type: r.mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = r.filename; a.click()
      URL.revokeObjectURL(url)
      setMsg(`已导出 ${r.filename}（${r.stats.scenes} 场 · ${r.stats.dialogueLines} 句台词 · ${r.stats.speakers.length} 个说话人）`)
    } catch (e: any) { setMsg(e?.message || '导出失败') } finally { setSaving(false) }
  }

  return <div className="story-script">
    <div className="story-script-head">
      <span>剧本 · {stats ? `${stats.scenes} 场 / ${stats.dialogueLines} 句台词` : '要素统计'}{stats?.speakers?.length ? ` / ${stats.speakers.length} 个说话人` : ''}</span>
      <button className="btn-ghost" disabled={busy} onClick={() => { setOpen(o => !o); void mutate() }}>{open ? '收起' : '剧本与导出'}</button>
    </div>
    {open && <div className="story-script-body">
      <p className="story-hint">
        导出用的是<strong>剧本要素</strong>：场景标题（场景设定里的内外景/地点/时间）、动作（「本段动作」留空则用画面描述）、
        角色与台词（从「本段台词」按「角色名：台词」拆出来）、转场（「转场」字段）。
      </p>
      {stats && <div className="story-script-stats">
        <span>场景 {stats.scenes}</span><span>动作 {stats.actions}</span><span>台词 {stats.dialogueLines}</span><span>转场 {stats.transitions}</span>
        <span>说话人：{stats.speakers.length ? stats.speakers.slice(0, 6).join('、') : '（还没有台词）'}</span>
      </div>}
      <div className="story-script-row">
        <label>格式<ThemedSelect aria-label="导出格式" value={format} disabled={busy || saving} onChange={e => setFormat(e.target.value)}>
          <option value="txt">中文剧本（.txt）</option>
          <option value="fountain">Fountain（.fountain）</option>
          <option value="fdx">Final Draft（.fdx）</option>
        </ThemedSelect></label>
        <button className="btn-ghost" disabled={busy || saving} onClick={exportIt}>{saving ? '导出中…' : '导出剧本'}</button>
        {onPatchProject && <button className="btn-ghost" disabled={busy} onClick={onPatchProject}>刷新</button>}
      </div>
      <p className="story-hint">FDX 结构按公开约定生成（Scene Heading / Action / Character / Parenthetical / Dialogue / Transition）；本机没有 Final Draft，所以<strong>没有真机打开验证过</strong>。</p>
      {msg && <p role="status" className="story-notice">{msg}</p>}
    </div>}
  </div>
}
