import { useState } from 'react'
import useSWR from 'swr'
import { LearningIntakeApi, RefineApi } from '../api'

const date = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无记录'

export default function LearningIntakePanel() {
  const history = useSWR('refine-status', () => RefineApi.status(), { refreshInterval: 60000 })
  const intake = useSWR('learning-intake-status', () => LearningIntakeApi.status(), { refreshInterval: 30000 })
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(20)
  const experience = history.data?.experience
  const candidates = intake.data?.candidates
  const collection = intake.data?.collection
  const entries = (experience?.entries || []).filter(e => `${e.title} ${e.preview}`.toLowerCase().includes(query.trim().toLowerCase()))
  const isLoading = history.isLoading || intake.isLoading
  const refresh = () => { void history.mutate(); void intake.mutate() }

  return (
    <section className="panel space-y-5 min-w-0" aria-label="日常积累">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-pi-text">日常积累</h3>
        <button className="btn-tool min-h-11 px-3 disabled:opacity-60" onClick={refresh} disabled={history.isValidating || intake.isValidating}>刷新记录</button>
      </div>
      {isLoading && <p role="status" className="text-sm text-pi-dim">正在读取经验与任务记录…</p>}
      {(history.error || experience?.error) && <p role="alert" className="text-sm text-pi-text">经验库读取失败，请刷新重试。已有内容不会被清空。</p>}
      {(intake.error || candidates?.ok === false) && <p role="alert" className="text-sm text-pi-text">任务候选记录暂不可读，请刷新重试；这不表示没有积累。</p>}
      <div className="space-y-2">
        <h4 className="font-medium text-pi-text">待提炼任务{candidates?.ok ? ` · ${candidates.count}` : ''}</h4>
        <p className="text-sm text-pi-dim">完成任务只登记本地候选，不等于已验证，也不会因此自动调用付费模型。只收录能确认属于当前工作空间的执行记录。</p>
        {!!candidates?.backlog && <p className="text-sm text-pi-text">还有 {candidates.backlog} 条待补记，其中 {candidates.failed || 0} 条上次写入失败；后台会重试。</p>}
        {candidates?.ok && !candidates.count && <p className="text-sm text-pi-dim">暂无待提炼任务。新的已完成任务会在这里登记。</p>}
        {!!candidates?.entries.length && <details>
          <summary className="cursor-pointer min-h-11 py-2 text-sm text-pi-text">查看最近任务（最多 20 条）</summary>
          <ul className="divide-y divide-pi-border-soft">
            {candidates.entries.slice(0, 20).map(e => <li key={`${e.runId}:${e.sessionId}`} className="py-3 space-y-1 [overflow-wrap:anywhere]">
              <p className="text-pi-text">{e.title}</p><p className="text-sm text-pi-dim">{date(e.at)} · 待提炼</p>
            </li>)}
          </ul>
        </details>}
        {!!candidates?.retired && <p className="text-sm text-pi-dim">候选列表保留最近 {candidates.limit} 条；已移出 {candidates.retired} 条较早候选，原执行账本不受影响。</p>}
      </div>
      <div className="space-y-2 border-t border-pi-border-soft pt-4">
        <h4 className="font-medium text-pi-text">会话观察采集</h4>
        {collection?.running ? <p role="status" className="text-sm text-pi-dim">正在采集，完成后刷新查看。</p> : collection?.at ? <p className="text-sm text-pi-dim">最近采集：{date(collection.at)}</p> : !intake.isLoading && !intake.error && <p className="text-sm text-pi-dim">尚无采集结果；服务启动后约 2 分钟首次检查，之后每 6 小时检查。</p>}
        {collection?.ok === false && <p role="alert" className="text-sm text-pi-text">采集未全部完成（{collection.failed ?? '未知'} 项失败）。失败文件不会被标记为完成；下轮会重试。状态文件损坏需先修复。</p>}
        {collection?.at && <p className="text-sm text-pi-dim">成功 {collection.succeeded || 0} · 未变化 {collection.skipped || 0} · 无可提取观察 {collection.empty || 0}{collection.reason === 'no_changes' ? ' · 本轮没有新变化，不是采集故障。' : ''}</p>}
      </div>
      <div className="space-y-3 border-t border-pi-border-soft pt-4">
        <h4 className="font-medium text-pi-text">经验库记录{experience && !experience.error ? ` · ${experience.count} 个标题` : ''}</h4>
        <p className="text-sm text-pi-dim [overflow-wrap:anywhere]">{experience?.source || '工程/经验库/experience.md'} · {date(experience?.updatedAt)}。这里展示原始记录摘要，标题数量不是验证通过数。</p>
        <label className="block text-sm text-pi-text">搜索经验摘要
          <input type="search" value={query} onChange={e => { setQuery(e.target.value); setShown(20) }} placeholder="输入关键词" className="mt-2 w-full min-h-11 rounded-pi-md border border-pi-border-soft bg-pi-bg2 px-3 text-base text-pi-text" />
        </label>
        {!history.isLoading && !history.error && !experience?.error && !entries.length && <p className="text-sm text-pi-dim">{query ? '没有匹配的经验摘要，试试其他关键词。' : '暂无经验标题；待提炼任务不会自动写成经验。'}</p>}
        <ul className="divide-y divide-pi-border-soft">
          {entries.slice(0, shown).map((e, i) => <li key={`${i}:${e.title}`} className="py-3 space-y-1 [overflow-wrap:anywhere]">
            <p className="font-medium text-pi-text">{e.title}</p><p className="text-sm text-pi-dim whitespace-pre-wrap">{e.preview}</p>
          </li>)}
        </ul>
        {entries.length > shown && <button className="btn-tool min-h-11 px-3" onClick={() => setShown(n => n + 20)}>再显示 20 条</button>}
        {!!experience && experience.count > (experience.entries?.length || 0) && <p className="text-sm text-pi-dim">这里只检索最近 500 个标题；完整历史保留在原文件。</p>}
      </div>
    </section>
  )
}
