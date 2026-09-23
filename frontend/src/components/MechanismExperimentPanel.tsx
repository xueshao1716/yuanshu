import { useState } from 'react'
import useSWR from 'swr'
import { FlaskConical } from 'lucide-react'
import { MechanismApi } from '../lib/mechanism-api'

const labels = {
  untested: '待验证', supported: '样例支持 · 限定场景', 'not-supported': '样例不支持',
  stale: '相关代码已变化 · 需要重测', invalid: '记录损坏 · 需要重测', error: '执行失败 · 未得出结论',
}

export default function MechanismExperimentPanel() {
  const { data, error, mutate, isLoading } = useSWR('mechanism-experiment', MechanismApi.status, { refreshInterval: 30000 })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const run = async () => {
    setBusy(true); setMessage('正在比较基线与干预，并检查反例…')
    try {
      const result = await MechanismApi.run()
      await mutate(result, false)
      setMessage('')
    } catch (e) {
      setMessage(`实验未完成：${e instanceof Error ? e.message : '请稍后重试'}`)
      void mutate()
    } finally { setBusy(false) }
  }
  const definition = data?.definition
  const latest = data?.latest
  return (
    <section className="panel !p-4 space-y-3" aria-label="机制实验">
      <div className="flex items-center gap-2 flex-wrap">
        <FlaskConical aria-hidden="true" className="w-4 h-4 text-pi-accent" />
        <h3 className="text-[14px] font-semibold text-pi-text">机制实验</h3>
        <span className="text-[12px] text-pi-dim">隔离样例 · OPHIS 思路试点</span>
      </div>
      <p className="text-[12px] leading-relaxed text-pi-dim">先提出可反驳的假设，再比较结果。这里不调用真实模型，也不把重复运行当成新增真实任务证据。</p>
      {isLoading && <p className="text-[12px] text-pi-dim">正在读取实验记录…</p>}
      {error && <p role="alert" className="text-[12px] text-pi-dim">实验记录读取失败，请稍后重试。</p>}
      {definition && <>
        <h4 className="text-[13px] font-medium text-pi-text">{definition.title}</h4>
        <dl className="text-[12px] leading-relaxed space-y-2">
          {[
            ['观察与证据', `${definition.observation} ${definition.evidence}`],
            ['问题', definition.problem], ['假设', definition.hypothesis],
            ['干预', definition.intervention], ['预期', definition.expectation], ['反证条件', definition.falsification],
          ].map(([label, value]) => <div key={label}>
            <dt className="font-medium text-pi-text">{label}</dt><dd className="text-pi-dim mt-0.5">{value}</dd>
          </div>)}
        </dl>
      </>}
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" className="btn-primary min-h-11 px-3 text-[13px] disabled:opacity-60"
          disabled={busy || data?.running} onClick={run}>
          {busy || data?.running ? '实验运行中…' : '运行隔离实验'}
        </button>
        <span role="status" aria-live="polite" className="text-[12px] text-pi-dim">{message || (data ? labels[data.state] : '')}</span>
      </div>
      {latest && <div className="space-y-2 text-[12px] text-pi-dim">
        <p>记录时间：{new Date(latest.at).toLocaleString()} · 代码版本 {latest.sourceVersion}</p>
        {data?.state === 'stale' && <p>以下为旧代码的历史结果，不能作为当前版本的通过证明。</p>}
        {latest.error && <p role="alert">{latest.error}</p>}
        <ul className="space-y-1.5">
          {latest.cases.map(row => <li key={row.id} className="flex justify-between gap-3 flex-wrap">
            <span>{row.label}</span><span className="tabular-nums">{row.beforeCount} → {row.afterCount} 张 · {row.passed ? '符合预期' : '未符合预期'}</span>
          </li>)}
        </ul>
        <details>
          <summary className="cursor-pointer touch-hit inline-flex items-center">查看代码指纹与运行记录</summary>
          <p className="break-all mt-2">{latest.sourceFingerprint}</p>
          <p className="mt-1">最近保留 {data?.recentRuns.length || 0} 次运行；独立真实任务证据仍为 0。</p>
        </details>
      </div>}
      <p className="text-[12px] text-pi-dim leading-relaxed">{definition?.scope}</p>
      <p className="text-[12px] text-pi-dim leading-relaxed">{data?.governance || '实验不写回策略；人工审批、真实任务验收与回滚仍按原有流程执行。'}</p>
    </section>
  )
}
