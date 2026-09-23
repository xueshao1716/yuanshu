import { useState } from 'react'
import { downloadApiFile, withFileToken } from '../api'
import { TaskEvidenceApi, acceptanceLabels, type EvidenceDetail, type Verdict } from '../lib/task-evidence-api'

export default function TaskEvidenceEditor({ row, onChange }: { row: EvidenceDetail; onChange: () => Promise<unknown> }) {
  const [skills, setSkills] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const save = async (verdict: Verdict) => {
    setBusy(true); setMessage('正在保存并复核进化证据…')
    try {
      const result = await TaskEvidenceApi.review(row, verdict, note, verdict === 'pass' ? skills : [])
      setMessage(result.evolutionError ? `验收已保存；策略复核未完成：${result.evolutionError}` : '验收已保存，证据资格已重新计算。')
      setSkills([]); setNote('')
      try { await onChange() }
      catch { setMessage('验收已保存，但页面刷新失败。请刷新记录后查看当前状态。') }
    } catch (e) {
      setMessage(`${e instanceof Error ? e.message : '保存失败'}。请刷新记录，重新核对后再提交。`)
    } finally { setBusy(false) }
  }
  const download = async (relative: string) => {
    try { await downloadApiFile(`/api/ws/file?path=${encodeURIComponent(relative)}`, relative.split('/').pop()) }
    catch (e) { setMessage(e instanceof Error ? e.message : '文件读取失败') }
  }
  return <div className="space-y-3 text-[13px] min-w-0" aria-label="任务验收详情">
    <p className="text-pi-text whitespace-pre-wrap break-words">{row.input}</p>
    <p className="text-pi-dim">验收：{acceptanceLabels[row.acceptance]} · 技能样本：{row.eligible ? '可评分' : '未取得资格'}</p>
    {row.review && <p className="text-pi-dim break-words">上次记录 {new Date(row.review.at).toLocaleString()}：{row.review.note}
      {row.review.skills.length > 0 && `（确认技能：${row.review.skills.join('、')}）`}</p>}
    <details open>
      <summary className="min-h-11 flex items-center cursor-pointer text-pi-text">查看本次回复与交付</summary>
      <pre className="whitespace-pre-wrap break-words font-sans text-pi-dim max-h-72 overflow-y-auto">{row.text || '本次没有文字回复。'}</pre>
      <ul className="space-y-3 mt-3">
        {row.artifacts.map((artifact, i) => <li key={`${artifact.path}-${i}`} className="break-all">
          <p className="text-pi-dim">{artifact.path}</p>
          {artifact.error ? <p className="text-pi-dim">{artifact.error}</p> : <>
            {/\.(png|jpe?g|webp|gif)$/i.test(artifact.path) && <img alt="本次交付图片" loading="lazy"
              className="max-w-full max-h-64 object-contain mt-2" src={withFileToken(`/api/ws/file?path=${encodeURIComponent(artifact.path)}`)} />}
            <button type="button" className="btn-ghost min-h-11 px-3" onClick={() => void download(artifact.path)}>下载核对</button>
          </>}
        </li>)}
      </ul>
    </details>
    {!!row.subagents?.length && <details>
      <summary className="min-h-11 flex items-center cursor-pointer text-pi-text">实际子任务调用（{row.subagents.length}）</summary>
      <p className="text-pi-dim">每条对应一次独立模型调用；以下为记录摘要。模型复核通过后仍需你验收。</p>
      <ul className="space-y-3 mt-2">
        {row.subagents.map(child => <li key={child.id} className="break-words min-w-0">
          <p className="text-pi-text">{child.role} · {({ completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', running: '执行中' } as Record<string, string>)[child.status] || child.status}</p>
          <p className="text-pi-dim break-all">{child.model || '模型未记录'} · {child.id}</p>
          <p className="text-pi-dim whitespace-pre-wrap max-h-40 overflow-y-auto">{child.summary || '尚无结束摘要'}</p>
        </li>)}
      </ul>
    </details>}
    {row.issues.length > 0 && <ul className="text-pi-dim space-y-1">{row.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    {row.lane !== 'team' && <>
      <fieldset disabled={busy || !row.reviewable} className="space-y-1">
        <legend className="text-pi-text">本次哪些技能选择合适？请单独确认</legend>
        <p className="text-pi-dim">不勾选也能验收任务，但不会生成技能学习标签。再次提交合格时，以这次勾选为准。</p>
        {row.skills.map(skill => <label key={skill} className="flex items-center gap-2 min-h-11 break-all">
          <input type="checkbox" checked={skills.includes(skill)} onChange={e => setSkills(old => e.target.checked ? [...old, skill] : old.filter(s => s !== skill))} />
          {skill}
        </label>)}
        {!row.skills.length && <p className="text-pi-dim">没有可确认的成功技能调用。</p>}
      </fieldset>
      <label className="block text-pi-text">验收说明
        <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={2000} disabled={busy} rows={3}
          className="input w-full mt-2 resize-y" placeholder="写下核对了什么，以及合格或有问题的原因" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary min-h-11 px-3" disabled={busy || !row.reviewable || !note.trim()} onClick={() => void save('pass')}>标记合格</button>
        <button type="button" className="btn-ghost min-h-11 px-3" disabled={busy || !note.trim()} onClick={() => void save('fail')}>标记有问题</button>
        <button type="button" className="btn-ghost min-h-11 px-3" disabled={busy || !row.review || !note.trim()} onClick={() => void save('revoke')}>撤销验收</button>
      </div>
    </>}
    <p role="status" aria-live="polite" className="text-pi-dim break-words">{message}</p>
  </div>
}
