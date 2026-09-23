// ── 工作台「天团」视图：共享会话任务入口与运行快照 ────────────────────────────
// 数据来源：GET /api/team/run → 工程/多AI角色扮演系统/team-run.json（八阶 runner 产出）
// 定位：母体（aibody）仪表盘里的"角色层"窗口——谁上场、什么档位、每阶到哪、清单对没对上。
// 快照只读；新任务通过统一会话管理器启动，角色只继承有限上下文。
import useSWR from 'swr'
import { TeamRunApi } from '../api'
import { TeamRunStart } from './TeamRunStart'
import { TeamRunStatus, type TeamDelivery, type TeamProfile } from './TeamRunStatus'


const TIER_STYLE: Record<string, string> = {
  决策层: 'bg-pi-accent/15 text-pi-accent',
  协调层: 'bg-pi-bg3 text-pi-text',
  执行层: 'bg-pi-bg2 text-pi-dim',
}

const fetchRun = () => TeamRunApi.get()
const STAGE_LABEL: Record<string, string> = { ok: '已完成', error: '失败', warn: '需复核', running: '运行中', pending: '待执行' }

export function TeamRunView() {
  const { data, error, isLoading } = useSWR('team-run', fetchRun, { refreshInterval: 10_000 })
  const run = (data as { run?: TeamRun | null } | undefined)?.run
  const hint = (data as { hint?: string } | undefined)?.hint
  const isCurrent = data?.snapshotKind === 'current'
  const running = ['running', 'launching', 'stopping'].includes(data?.launch?.status || '')

  if (error) return <div className="panel p-4 text-[13px] text-pi-dim">天团数据读取失败：{String((error as Error)?.message || error)}</div>
  if (isLoading) return <div role="status" className="panel p-4 text-pi-dim">正在读取天团运行记录…</div>
  if (!run) {
    return (
      <div className="flex flex-col gap-3">
        <TeamRunStart running={running} />
        <TeamRunStatus launch={data?.launch} />
        <div className="panel p-4 flex flex-col gap-2">
        <div className="text-[13px] font-semibold text-pi-text">还没有视频专用流程记录</div>
        <div className="text-[12px] text-pi-dim">{hint || '提交视频脚本任务后，运行记录会在这里显示。'}</div>
        </div>
      </div>
    )
  }

  const cfg = run.spec?.config || {}
  return (
    <div className="flex flex-col gap-3">
      <TeamRunStart running={running} />
      <TeamRunStatus launch={data?.launch} launchId={run.launchId} />
      <details key={`${run.launchId || run.createdAt || 'legacy'}-${isCurrent}`} open={isCurrent} className="flex flex-col gap-3">
      <summary className="panel p-3 cursor-pointer text-sm text-pi-text break-words focus-visible:outline focus-visible:outline-pi-accent">
        视频专用 · {isCurrent ? '当前运行记录' : '历史运行记录（展开查看）'} · {run.task || '未记录任务名称'}
      </summary>
      <div className="flex flex-col gap-3 pt-3">
      <TeamRunStatus showLaunch={false} profile={run.profile} delivery={run.delivery} acceptance={data?.acceptance} />
      <div className="panel px-3 py-2 text-[11px] text-pi-dim border-l-2 border-pi-accent">
        {run.mode === 'real' ? (
          <>
            真跑（real）：这是一次模型调用的运行记录，不代表每阶成功或交付已验收。
            <b className="text-pi-text">请核对阶段状态与校验证据；历史记录中的“通过”仍可能需要复核。</b>
          </>
        ) : run.mode === 'dry-run' ? (
          <>
            演练模式（dry-run）：档位 / 上场名单 / 清单对账 / 信号都是真的，<b className="text-pi-text">各阶产物仍是占位</b>——真版接模型调用后同一张视图不用改。
          </>
        ) : <span>运行模式未提供或未知，请核对来源，不据此认定发生了真实模型调用。</span>}
      </div>

      {/* 一趟运行：任务 + 三维配置 + 档位 */}
      <div className="panel p-3 flex flex-col gap-2">
        <div className="text-[12px] text-pi-dim">{isCurrent ? '当前任务' : '历史任务（不在运行）'}</div>
        <div className="text-[13px] text-pi-text break-all">{run.task}</div>
        <div className="text-[11px] text-pi-dim">记录时间：{run.createdAt ? new Date(run.createdAt).toLocaleString() : '未提供'} · 只读快照，不代表正在运行</div>
        {!run.profile?.version && <div className="text-[11px] text-pi-dim">未标注流程版本的历史记录，不按 V20 / V25 解释 S8.5；请以该次运行的阶段说明为准。</div>}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-text">
            配置 {[cfg.collab, cfg.verify, cfg.enhance].filter(Boolean).join('-') || '—'}
          </span>
          <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-text">
            种姓 {run.spec?.caste || '—'} · 三相 {run.spec?.phase || '—'}
          </span>
          <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-dim">
            并发上限 {run.concurrencyCap ?? run.spec?.concurrencyCap ?? '—'}
          </span>
          <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-dim">
            清单 {run.checklist?.passed ?? '—'}/{run.checklist?.total ?? '—'}（{run.checklist?.tier || '未提供'}）
          </span>
          {run.model && <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg2 text-pi-dim">模型 {run.model}</span>}
          {run.drivenBy && (
            <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg2 text-pi-dim" title={run.drivenBy}>
              驱动 {String(run.drivenBy).includes('team-run-live') ? '元枢自己（服务端）' : '外部驱动'}
            </span>
          )}
        </div>
      </div>

      {/* 上场名单 */}
      <div className="panel p-3 flex flex-col gap-2">
        <div className="text-[12px] font-semibold text-pi-text">上场名单（{(run.roster || []).length} 人）</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(run.roster || []).map((r) => (
            <div key={r.id} className="rounded-pi-md bg-pi-bg3 p-2 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-pi-text">{r.cn}</span>
                <span className="text-[10px] text-pi-dim">{r.id}</span>
                <span className={'text-[10px] px-1.5 py-0.5 rounded-pi-pill ml-auto ' + (TIER_STYLE[r.tier] || 'bg-pi-bg2 text-pi-dim')}>{r.tier}</span>
                {r.mode === 'shadow' && <span className="text-[10px] text-pi-dim">影子</span>}
              </div>
              <div className="text-[11px] text-pi-dim line-clamp-2">{r.duty}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 八阶 */}
      <div className="panel p-3 flex flex-col gap-2">
        <div className="text-[12px] font-semibold text-pi-text">八阶工作流</div>
        <div className="flex flex-wrap items-center gap-1">
          {(run.stages || []).map((s, i) => (
            <span key={s.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-pi-dim text-[11px]">→</span>}
              <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-text" title={s.owner + '：' + s.note}>
                <b className="text-pi-accent">{s.id}</b> {s.cn} · {STAGE_LABEL[s.status || ''] || '状态未提供'}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* 产物：每个角色交付了什么（真跑时是模型原文；点开看全量） */}
      {!!(run.artifacts || []).length && (
        <div className="panel p-3 flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-pi-text">产物（{(run.artifacts || []).length} 份）</div>
          {(run.artifacts || []).map((a, i) => (
            <details key={i} className="rounded-pi-md bg-pi-bg3 p-2">
              <summary className="text-[11px] text-pi-text cursor-pointer">
                <b>{a.role}</b>
                {a.kind ? ` · ${a.kind}` : ''}
                <span className="text-pi-dim">（{String(a.text || '').length} 字，点开看）</span>
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] text-pi-dim max-h-72 overflow-auto">{a.text}</pre>
            </details>
          ))}
        </div>
      )}

      {/* 清单未通过项（不许被抹平：一条条留在这里） */}
      {!!(run.checklistFailed || []).length && (
        <div className="panel p-3 flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-pi-text">清单未通过（{(run.checklistFailed || []).length} 条）</div>
          {run.checklistNote && <div className="text-[11px] text-pi-accent">{run.checklistNote}</div>}
          {(run.checklistFailed || []).map((c) => (
            <div key={c.id} className="text-[11px] text-pi-dim">
              <span className={c.severity === 'block' ? 'text-pi-accent' : 'text-pi-text'}>{c.id}</span> {c.name}
              {c.note ? ` · ${c.note}` : ''}
            </div>
          ))}
        </div>
      )}

      {/* 待你定（天团不替人做决定：未决项原样摆出来） */}
      {!!(run.unresolved || []).length && (
        <div className="panel p-3 flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-pi-text">待你定（{(run.unresolved || []).length} 项）</div>
          {(run.unresolved || []).map((u, i) => (
            <div key={i} className="text-[11px] text-pi-dim">
              <span className="text-pi-text">{u.item}</span>
              {u.options?.length ? ` —— ${u.options.join(' / ')}` : ''}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 改动经验（这次运行沉淀了什么） */}
        <div className="panel p-3 flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-pi-text">改动经验（本次）</div>
          {(run.experiences || []).map((e, i) => (
            <div key={i} className="text-[11px] text-pi-dim">
              <span className="text-pi-text">{e.from}</span> · {e.text}
            </div>
          ))}
          {!(run.experiences || []).length && <div className="text-[11px] text-pi-dim">（无）</div>}
        </div>
        {/* 信号黑板（信息素） */}
        <div className="panel p-3 flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-pi-text">信号黑板</div>
          {(run.pheromone || []).slice(-4).map((p, i) => (
            <div key={i} className="text-[11px] text-pi-dim">
              <span className="text-pi-text">{p.type}</span> ← {p.from}（{p.hint}，强度 {p.intensity}）
            </div>
          ))}
        </div>
      </div>
      </div>
      </details>
    </div>
  )
}

type TeamRun = {
  launchId?: string | null
  profile?: TeamProfile
  delivery?: TeamDelivery
  createdAt?: string
  mode?: string
  drivenBy?: string
  model?: string
  task?: string
  spec?: { kind?: string; complexity?: string; config?: Record<string, string>; caste?: string; phase?: string; concurrencyCap?: number }
  concurrencyCap?: number
  roster?: { id: string; cn: string; tier: string; duty: string; mode?: string }[]
  stages?: { id: string; cn: string; owner: string; note?: string; output?: string; status?: string }[]
  checklist?: { tier?: string; total?: number; passed?: number }
  checklistFailed?: { id: string; name: string; note?: string; severity?: string }[]
  checklistNote?: string
  unresolved?: { item: string; options?: string[] }[]
  artifacts?: { role: string; kind?: string; text: string }[]
  experiences?: { from: string; text: string }[]
  pheromone?: { type: string; from: string; hint: string; intensity: number }[]
}
