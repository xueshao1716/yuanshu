// ── 工作台「天团」视图（只读，2026-09-19）──────────────────────────────────────
// 数据来源：GET /api/team/run → 工程/多AI角色扮演系统/team-run.json（八阶 runner 产出）
// 定位：母体（aibody）仪表盘里的"角色层"窗口——谁上场、什么档位、每阶到哪、清单对没对上。
// 只读：这里不改任何运行逻辑，也不把天团塞进对话提示词（那会污染前台）。
import useSWR from 'swr'


const TIER_STYLE: Record<string, string> = {
  决策层: 'bg-pi-accent/15 text-pi-accent',
  协调层: 'bg-pi-bg3 text-pi-text',
  执行层: 'bg-pi-bg2 text-pi-dim',
}

// 用显式带鉴权头的 fetch（与 ChatArea/小语挂件同一套写法——那里的写法在本机是真机验过的）
const fetchRun = async () => (await fetch('/api/team/run', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('yuanshu_access_token') || '') } })).json()

export function TeamRunView() {
  const { data, error } = useSWR('team-run', fetchRun, { refreshInterval: 10_000 })
  const run = (data as { run?: TeamRun | null } | undefined)?.run
  const hint = (data as { hint?: string } | undefined)?.hint

  if (error) return <div className="panel p-4 text-[13px] text-pi-dim">天团数据读取失败：{String((error as Error)?.message || error)}</div>
  if (!run) {
    return (
      <div className="panel p-4 flex flex-col gap-2">
        <div className="text-[13px] font-semibold text-pi-text">还没有天团运行记录</div>
        <div className="text-[12px] text-pi-dim">跑一次演练，这个页面就会有数据：</div>
        <code className="text-[11px] text-pi-text bg-pi-bg3 rounded-pi-md px-2 py-1.5 break-all">
          {hint || 'node 工程/多AI角色扮演系统/scripts/team-run.mjs "写一个 10 秒飞天舞者视频脚本"'}
        </code>
      </div>
    )
  }

  const cfg = run.spec?.config || {}
  return (
    <div className="flex flex-col gap-3">
      <div className="panel px-3 py-2 text-[11px] text-pi-dim border-l-2 border-pi-accent">
        {run.mode === 'real' ? (
          <>
            真跑（real）：下面每一阶的产物都是**模型真实产出**，清单也是按条目逐条对账的；
            <b className="text-pi-text">未通过的条目会留在清单里</b>，不会被"抹平"。
          </>
        ) : (
          <>
            演练模式（dry-run）：档位 / 上场名单 / 清单对账 / 信号都是真的，<b className="text-pi-text">各阶产物仍是占位</b>——真版接模型调用后同一张视图不用改。
          </>
        )}
      </div>

      {/* 一趟运行：任务 + 三维配置 + 档位 */}
      <div className="panel p-3 flex flex-col gap-2">
        <div className="text-[12px] text-pi-dim">当前任务</div>
        <div className="text-[13px] text-pi-text break-all">{run.task}</div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-text">
            配置 {[cfg.collab, cfg.verify, cfg.enhance].filter(Boolean).join('-') || '—'}
          </span>
          <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-text">
            种姓 {run.spec?.caste || '—'} · 三相 {run.spec?.phase || '—'}
          </span>
          <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-dim">
            并发上限 {run.concurrencyCap ?? '—'}
          </span>
          <span className="text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-dim">
            清单 {run.checklist?.passed}/{run.checklist?.total}（{run.checklist?.tier}）
          </span>
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
                <b className="text-pi-accent">{s.id}</b> {s.cn}
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
  )
}

type TeamRun = {
  mode?: string
  task?: string
  spec?: { kind?: string; complexity?: string; config?: Record<string, string>; caste?: string; phase?: string }
  concurrencyCap?: number
  roster?: { id: string; cn: string; tier: string; duty: string; mode?: string }[]
  stages?: { id: string; cn: string; owner: string; note?: string; output?: string }[]
  checklist?: { tier?: string; total?: number; passed?: number }
  checklistFailed?: { id: string; name: string; note?: string; severity?: string }[]
  checklistNote?: string
  unresolved?: { item: string; options?: string[] }[]
  artifacts?: { role: string; kind?: string; text: string }[]
  experiences?: { from: string; text: string }[]
  pheromone?: { type: string; from: string; hint: string; intensity: number }[]
}

