import { useState } from 'react'
import useSWR from 'swr'
import TaskEvidenceEditor from './TaskEvidenceEditor'
import { TaskEvidenceApi, acceptanceLabels } from '../lib/task-evidence-api'

const phases: Record<string, string> = { collecting: '收集证据', shadow: '后续观察', ready: '等待治理检查',
  canary: '受限试运行', active: '已启用', rejected: '候选未通过', rollback_required: '需要回滚', rolled_back: '已回滚', superseded: '配置已另行变更' }
const statuses: Record<string, string> = { queued: '排队中', running: '运行中', completed: '执行完成',
  failed: '执行失败', stopped: '已停止', interrupted: '已中断', stopping: '正在停止' }

export default function TaskEvidencePanel() {
  const [selected, setSelected] = useState('')
  const [evaluating, setEvaluating] = useState(false)
  const [message, setMessage] = useState('')
  const list = useSWR('task-evidence-list', TaskEvidenceApi.list, { refreshInterval: 30000 })
  const status = useSWR('task-evidence-status', TaskEvidenceApi.status, { refreshInterval: 30000 })
  const detail = useSWR(selected ? ['task-evidence-detail', selected] : null, () => TaskEvidenceApi.get(selected), { revalidateOnFocus: false })
  const progress = status.data?.evolution.progress
  const team = status.data?.evolution.team
  const refresh = async () => { await Promise.all([list.mutate(), status.mutate(), detail.mutate()]) }
  const evaluate = async () => {
    setEvaluating(true); setMessage('正在复核候选与现役策略…')
    try { await TaskEvidenceApi.evaluate(); await refresh(); setMessage('复核已完成，请查看当前阶段与原因。') }
    catch (e) { setMessage(e instanceof Error ? e.message : '复核失败，请稍后重试') }
    finally { setEvaluating(false) }
  }
  return <section className="panel !p-4 space-y-4 min-w-0" aria-label="真实任务验收">
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <h3 className="text-[14px] font-semibold text-pi-text">真实任务验收</h3>
      <button type="button" className="btn-ghost min-h-11 px-3 text-[13px]" onClick={() => void refresh().catch(() => setMessage('刷新失败，请稍后重试。'))}>刷新验收记录</button>
    </div>
    <p className="text-[12px] leading-relaxed text-pi-dim">执行完成后，请查看实际交付再验收。验收绑定这一次任务和文件内容；交付变化或撤销后，旧标签退出评分。隔离实验不计入真实任务。</p>
    {(list.error || status.error) && <p role="alert" className="text-[13px] text-pi-dim">记录读取失败，请刷新重试。</p>}
    {progress && <div className="space-y-2 text-[13px] text-pi-dim" aria-label="进化进度">
      <h4 className="font-medium text-pi-text">进化进度 · {phases[progress.phase] || progress.phase}</h4>
      <p>技能观察 {progress.observed} 条 · 可评分 {progress.qualified} 条 · 去重任务 {progress.groups} 组</p>
      {list.data && <>
        <p>任务验收：合格 {list.data.summary.pass} · 有问题 {list.data.summary.fail} · 已失效 {list.data.summary.stale} · 已撤销 {list.data.summary.revoke} · 异常 {list.data.summary.invalid}</p>
        <p>合格交付覆盖：{Object.entries({ text: '文字', image: '图片', document: '文档', code: '代码', media: '影音', other: '其他' })
          .map(([key, label]) => `${label} ${list.data!.summary.coverage[key] || 0}`).join(' · ')}（同一任务可跨类型）</p>
      </>}
      <div className="flex flex-wrap gap-x-5 gap-y-2 tabular-nums">
        <span>发现 {progress.discovery.count}/{progress.discovery.required}</span>
        <span>保留验证 {progress.holdout.count}/{progress.holdout.required}</span>
        <span>后续观察 {progress.future.count}/{progress.future.required}</span>
        <span>试运行 {progress.canary.count}/{progress.canary.required}</span>
      </div>
      <p>{progress.reason}</p>
      <p>候选：{progress.candidate || '尚无'} · {progress.enabled ? '已进入使用阶段' : '未在使用候选'}</p>
      {progress.expiresAt && <p>试运行期限：{new Date(progress.expiresAt).toLocaleString()}</p>}
      {progress.checkedAt && <p>策略上次复核：{new Date(progress.checkedAt).toLocaleString()}</p>}
      <p>{progress.note}</p>
      <p>修复重试策略：{phases[status.data?.evolution.explore?.phase || 'collecting']}。任务验收不会充当重试轨迹。</p>
      <p>视频专用天团：观察 {team?.observed || 0} 条，现行验收合格 {team?.accepted || 0} 条；沿用视频送审流程。通用协作在下方按实际交付验收。</p>
      <button type="button" className="btn-ghost min-h-11 px-3" disabled={evaluating} onClick={() => void evaluate()}>复核进化证据</button>
      <p role="status" aria-live="polite">{message}</p>
    </div>}
    {list.isLoading && <p className="text-[13px] text-pi-dim">正在读取真实任务…</p>}
    {list.data && <p className="text-[12px] text-pi-dim">展示最近 {list.data.limit} 次及已验收运行，共 {list.data.items.length} / {list.data.total} 次 · 已留存 {list.data.retainedReviews}/{list.data.reviewLimit} 条验收</p>}
    {list.data?.items.length === 0 && <p className="text-[13px] text-pi-dim">暂无运行记录。完成任务后会出现在这里。</p>}
    <ul className="space-y-2">
      {list.data?.items.map(row => <li key={row.runId}>
        <button type="button" className="btn-ghost min-h-11 w-full !text-left !justify-start !whitespace-normal px-3 py-2"
          aria-expanded={selected === row.runId} onClick={() => setSelected(old => old === row.runId ? '' : row.runId)}>
          <span className="block min-w-0">
            <span className="block text-[13px] break-words">{row.input || '未记录任务说明'}</span>
            <span className="block text-[12px] text-pi-dim mt-1">{new Date(row.at).toLocaleString()} · {statuses[row.status] || row.status} · {row.lane === 'team' ? '天团送审' : acceptanceLabels[row.acceptance]}</span>
          </span>
        </button>
        {selected === row.runId && <div className="border-l-2 border-pi-border pl-3 ml-1 mt-2">
          {detail.isLoading && <p className="text-[13px] text-pi-dim">正在核对任务和交付内容…</p>}
          {detail.error && <p role="alert" className="text-[13px] text-pi-dim">本次记录无法读取，请刷新。</p>}
          {detail.data && <TaskEvidenceEditor key={`${row.runId}:${detail.data.digest}`}
            row={detail.data} onChange={refresh} />}
        </div>}
      </li>)}
    </ul>
  </section>
}
