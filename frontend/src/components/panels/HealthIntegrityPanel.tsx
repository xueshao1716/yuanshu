// 自证 / 准入 + 旁路留痕（/api/self-change/admissions · /api/self-change/bypasses）——只读
// 两块合在一个文件里，因为它们是同一个问题的两面：改自己之前有没有先自证（准入），
// 以及哪些入口**没走**这道闸（旁路）。
// 刻意不显示：filesetHash（一串 64 位摘要，用户读不懂也不需要用）、files 里的具体代码路径、
// unrelated 改动清单——只报"几个文件""哪一步没过"。旁路的 route 放进 tooltip，
// 正文优先用 note，因为 route 是内部接口名，不是给人读的句子。
import useSWR from 'swr'
import { HerApi, finite } from '../../lib/her-api'
import { EmptyLine, FailureLine, LoadingLine, Tag } from '../readout'
import { fmtMsgTime } from '../../lib/fmt-time'

const STEP_LABELS: Record<string, string> = { syntax: '语法', import: '导入', tests: '测试', deps: '依赖' }

export function HealthAdmissionsPanel() {
  const { data, error, mutate } = useSWR('her-admissions', HerApi.admissions, { refreshInterval: 300000, revalidateOnFocus: true })
  if (error) return <FailureLine error={error} onRetry={() => void mutate()} />
  if (!data) return <LoadingLine />

  const items = data.items || []
  if (!items.length) {
    return <EmptyLine>暂无自证/准入记录：她还没改过自己，或改动还没走到这道闸。</EmptyLine>
  }

  return (
    <ul className="space-y-3">
      {items.map((item, index) => (
        <li key={`${item.at}-${index}`} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Tag tone="info">{item.kind === 'admit' ? '准入' : '自证'}</Tag>
            <Tag tone={item.ok === false ? 'danger' : 'ok'}>{item.ok === false ? '未通过' : '通过'}</Tag>
            <span className="text-pi-dim2">{item.at ? fmtMsgTime(item.at) : '时间未记录'}</span>
            <span className="text-pi-dim2">·</span>
            <span className="text-pi-dim">{finite(item.files?.length)} 个文件</span>
          </div>
          {item.reason && <p className="text-xs text-pi-dim break-words">{item.reason}</p>}
          {!!item.steps?.length && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
              {item.steps.map(step => (
                <span key={step.name} className={step.ok === false ? 'text-pi-red' : step.skipped ? 'text-pi-dim2' : 'text-pi-green'}>
                  {STEP_LABELS[String(step.name)] || step.name}
                  {step.ok === false ? ' ✗' : step.skipped ? '（跳过）' : ' ✓'}
                </span>
              ))}
            </p>
          )}
          {!!item.uncovered?.length && (
            <p className="text-[11px] text-pi-yellow">无测试覆盖 {item.uncovered.length} 个文件（不拦，但要知情）。</p>
          )}
          {item.note && <p className="text-[11px] text-pi-dim2 break-words">{item.note}</p>}
        </li>
      ))}
    </ul>
  )
}

export function HealthBypassesPanel() {
  const { data, error, mutate } = useSWR('her-bypasses', HerApi.bypasses, { refreshInterval: 300000, revalidateOnFocus: true })
  if (error) return <FailureLine error={error} onRetry={() => void mutate()} />
  if (!data) return <LoadingLine />

  const items = data.items || []
  const total = finite(data.total, items.length)

  return (
    <div className="space-y-2">
      {total > 0 && (
        <p className="text-xs text-pi-dim">
          累计 <strong className="font-mono tabular-nums text-pi-text">{total}</strong> 条旁路记录（显示最近 {items.length} 条）
        </p>
      )}
      {items.length ? (
        <ul className="space-y-1.5">
          {items.map((item, index) => (
            <li key={`${item.at}-${index}`} className="text-xs text-pi-dim" title={item.route ? `入口：${item.route}` : undefined}>
              <span className="text-pi-dim2">{item.at ? fmtMsgTime(item.at) : '时间未记录'}</span>
              <span className="mx-1.5 text-pi-dim2">·</span>
              <span className="text-pi-text break-words">{item.note || item.route || '未写说明'}</span>
              {finite(item.files?.length) > 0 && <span className="ml-1.5 text-pi-dim2">涉及 {finite(item.files?.length)} 个文件</span>}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyLine>没有旁路记录：所有改自己的动作都走了自证准入。</EmptyLine>
      )}
    </div>
  )
}
