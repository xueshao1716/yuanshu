// 定时任务：分类 + 双模式审计（/api/scheduled/audit）——只读
// 这张表回答"后台自己按点干活的那 32 件事，各自该不该调模型、计划有没有违约"。
// 刻意不显示：作业落在哪一行代码（where 里的 server.mjs:586）、执行脚本名、plan.steps——
// 行号和脚本是开发视角的定位信息，用户要的是"哪件事、多久一回、归哪类、有没有违约"。
import useSWR from 'swr'
import { HerApi, JOB_KIND_LABELS, finite } from '../../lib/her-api'
import { EmptyLine, FailureLine, LoadingLine, Tag } from '../readout'

export default function HealthAssemblyPanel() {
  const { data, error, mutate } = useSWR('her-scheduled-audit', HerApi.scheduledAudit, { refreshInterval: 300000, revalidateOnFocus: true })
  if (error) return <FailureLine error={error} onRetry={() => void mutate()} />
  if (!data) return <LoadingLine />

  const total = finite(data.total)
  if (!total) return <EmptyLine>暂无定时作业登记。</EmptyLine>

  const counts = data.counts || {}
  const jobs = data.jobs || []
  const violations = data.violations || []
  const planOk = jobs.filter(job => job.planOk === true).length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-pi-dim">
        <span>共 <strong className="font-mono tabular-nums text-pi-text">{total}</strong> 个作业</span>
        <span className="inline-flex items-center gap-1.5"><Tag tone="info">纯脚本</Tag>{finite(counts.deterministic)}</span>
        <span className="inline-flex items-center gap-1.5"><Tag tone="warn">需模型判断</Tag>{finite(counts.needsJudgement)}</span>
        <span className="inline-flex items-center gap-1.5">
          <Tag tone={violations.length ? 'danger' : 'ok'}>{violations.length ? `${violations.length} 处违约` : '无违约'}</Tag>
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <Tag tone={planOk === jobs.length ? 'ok' : 'warn'}>计划自检 {planOk}/{jobs.length}</Tag>
        </span>
      </div>

      <p className="text-[11px] leading-relaxed text-pi-dim2">
        分类规则：固定产出、不需要判断的活走脚本；要读上下文、要权衡的才调模型。两类都在同一份快照里审计，
        所以"该用模型却用了脚本"（或反过来）能当场看出来。
      </p>

      {violations.length > 0 && (
        <ul className="space-y-1">
          {violations.map((item, index) => (
            <li key={item.id || index} className="text-xs text-pi-red">
              {item.id || '未命名作业'}{item.reason ? `：${item.reason}` : item.kind ? `：${item.kind}` : ''}
            </li>
          ))}
        </ul>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-pi-dim hover:text-pi-text transition-colors">展开 {jobs.length} 个作业明细（节奏 / 归类 / 自检）</summary>
        <ul className="mt-2 space-y-2">
          {jobs.map(job => (
            <li key={job.id}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <span className="text-pi-text break-words">{job.note || job.id || '未命名作业'}</span>
                <Tag tone={job.kind === 'deterministic' ? 'info' : 'warn'}>{JOB_KIND_LABELS[String(job.kind)] || job.kind || '未分类'}</Tag>
                <Tag tone={job.planOk ? 'ok' : 'danger'}>{job.planOk ? '计划通过' : '计划异常'}</Tag>
                {job.every && <span className="ml-auto font-mono text-[11px] text-pi-dim2">{job.every}</span>}
              </div>
              {job.reason && <p className="mt-0.5 text-[11px] text-pi-dim2 break-words">{job.reason}</p>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
