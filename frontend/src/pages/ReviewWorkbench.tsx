import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  Bot, Check, ChevronDown, ChevronRight, CircleAlert, Clock3, ExternalLink,
  FileCode2, GitBranch, GitCompare, Layers3, PackageOpen, RefreshCw, ShieldCheck,
} from 'lucide-react'
import { AIBodyApi, GitReviewApi, SubagentApi, type AIBodyLayer, type GitReviewFile, type SubagentHistoryRun } from '../api'

const emptyFiles: GitReviewFile[] = []
const statusLabel = (status: GitReviewFile['status']) => ({ untracked: '未跟踪', added: '新增', deleted: '删除', renamed: '重命名', modified: '修改' }[status])
const runLabel = (state: string) => ({ completed: '已完成', complete: '已完成', done: '已完成', failed: '失败', stopped: '已停止', running: '运行中', active: '运行中', queued: '排队中', waiting: '等待中', needs_attention: '需关注' }[state] || state || '未知')
const runTone = (state: string) => ['completed', 'complete', 'done'].includes(state) ? 'success' : ['failed', 'stopped'].includes(state) ? 'danger' : ['running', 'active', 'queued', 'waiting'].includes(state) ? 'accent' : 'muted'

function diffLineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'review-diff-line review-diff-file'
  if (line.startsWith('+')) return 'review-diff-line review-diff-add'
  if (line.startsWith('-')) return 'review-diff-line review-diff-remove'
  if (line.startsWith('@@')) return 'review-diff-line review-diff-hunk'
  return 'review-diff-line'
}

function diffForFile(diff: string, filePath?: string) {
  if (!diff || !filePath) return ''
  const sections = diff.split(/(?=^diff --git )/m)
  return sections.find(section => section.includes(` a/${filePath}`) || section.includes(` b/${filePath}`)) || ''
}

function fileGroup(pathname: string) {
  const lower = pathname.toLowerCase()
  // public/assets is the checked-in snapshot of the frontend build, not source.
  if (/^public[\\/]assets([\\/]|$)/.test(lower)) return '生成物'
  if (/(^|[\\/])(frontend[\\/]dist|dist|build|out|coverage)([\\/]|$)/.test(lower)) return '生成物'
  if (/\.(png|jpe?g|gif|webp|svg|mp4|mp3|wav)$/.test(lower)) return '生成物'
  if (/\.(md|txt|docx?|pdf)$/.test(lower)) return '文档'
  if (/\.(log|bak|tmp|zip|exit)$/.test(lower) || /(^|[\\/])\.?(?:tmp|temp)(?:[-_.\\/]|$)/.test(lower) || /(^|[\\/])(backup|backups)([\\/]|$)/.test(lower)) return '临时文件'
  return '源码'
}

function formatDate(value?: string | null) {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatDuration(ms?: number | null) {
  if (!ms || ms < 1000) return ms ? `${ms} ms` : '—'
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function LayerCard({ layer }: { layer: AIBodyLayer }) {
  const available = layer.modules.filter(module => module.available).length
  const isSoil = layer.id === 'organism'
  return <article className="review-layer-card">
    <div className="review-layer-top"><span className="review-layer-index">{layer.id === 'host' ? '01' : layer.id === 'organism' ? '02' : '03'}</span><div className="min-w-0"><h3>{layer.label}</h3><p>{layer.summary}</p></div><span className="review-evidence-count">有读数 {available}/{layer.modules.length}</span></div>
    <div className={`review-layer-modules ${isSoil ? 'is-soil' : ''}`}>{layer.modules.map(module => (
      <div key={module.path} className={`review-layer-module ${module.available ? 'is-available' : ''} ${isSoil ? 'is-soil' : ''}`} title={module.summary || module.path}>
        <span className="review-module-dot" />
        <span className="truncate">{module.label}</span>
        {/* 土壤五项：显示真实读数。此前只显示"可用/不可用"，而 summary 早已算好并被丢在渲染层。 */}
        {isSoil
          ? <span className="review-module-reading">{module.summary || '无读数'}</span>
          : <code>{module.path}</code>}
        {isSoil ? <span className={`review-module-status ${module.available ? 'is-ok' : ''}`}>{module.statusLabel || (module.available ? '已观测' : '未观测')}</span> : null}
      </div>
    ))}</div>
  </article>
}

function RunRecord({ run }: { run: SubagentHistoryRun }) {
  const tone = runTone(run.state)
  return <article className="review-run-card">
    <div className="review-run-mark"><Bot className="w-4 h-4" /></div>
    <div className="min-w-0 flex-1">
      <div className="review-run-head"><span className="review-run-agent truncate">{run.agent || '子智能体'}</span><span className={`review-run-badge review-run-badge-${tone}`}>{runLabel(run.state)}</span><time>{formatDate(run.startedAt || run.updatedAt)}</time></div>
      <p className="review-run-task">{run.task || '未记录任务描述'}</p>
      <div className="review-run-meta"><span>{run.model || '模型未记录'}</span>{run.durationMs != null && <span><Clock3 className="w-3 h-3" />{formatDuration(run.durationMs)}</span>}{run.toolCount != null && <span>工具 {run.toolCount}</span>}{run.eventCount != null && <span>事件 {run.eventCount}</span>}</div>
      {run.error && <p className="review-run-error"><CircleAlert className="w-3.5 h-3.5" />{run.error}</p>}
      {run.acceptanceStatus && <p className="review-run-note"><ShieldCheck className="w-3.5 h-3.5" />验收：{run.acceptanceStatus}</p>}
      {(run.reviewFindings?.length || run.residualRisks?.length) ? <div className="review-run-findings">{run.reviewFindings?.slice(0, 2).map(item => <span key={`f-${item}`}>发现 · {item}</span>)}{run.residualRisks?.slice(0, 2).map(item => <span key={`r-${item}`}>风险 · {item}</span>)}</div> : null}
    </div>
  </article>
}

// 改动验收面板：已并入「工作台」（pages/Board.tsx）作为一个视图，因此不再自带 PageHeader，
// 也不再自己拉运行概览——近期工作说明由工作台共享层统一渲染一次，
// 避免同一接口用两个 SWR key 各拉一遍。
export function ReviewPanel() {
  const { data: review, error, isLoading, mutate } = useSWR('git-review', () => GitReviewApi.review(), { refreshInterval: 30000, revalidateOnFocus: true })
  const { data: history } = useSWR('subagent-history', () => SubagentApi.history(), { refreshInterval: 30000, revalidateOnFocus: true })
  const { data: aibody, error: aibodyError } = useSWR('aibody-overview', () => AIBodyApi.overview(), { refreshInterval: 120000, revalidateOnFocus: true })
  const [selectedPath, setSelectedPath] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [openMissions, setOpenMissions] = useState<Set<string>>(new Set())
  const [openFileGroups, setOpenFileGroups] = useState<Set<string>>(new Set(['源码']))
  const files = review?.files || emptyFiles
  const selected = files.find(file => file.path === selectedPath) || files[0]
  const verification = review?.verification || { state: 'unknown', checks: [] }
  const summary = useMemo(() => ({ additions: files.reduce((sum, file) => sum + (file.additions || 0), 0), deletions: files.reduce((sum, file) => sum + (file.deletions || 0), 0) }), [files])
  const groupedFiles = useMemo(() => {
    const groups = new Map<string, GitReviewFile[]>()
    files.forEach(file => { const key = file.status === 'untracked' ? fileGroup(file.path) : '已修改'; groups.set(key, [...(groups.get(key) || []), file]) })
    return [...groups.entries()]
  }, [files])
  const missions = history?.missions || []
  const recentRuns = (history?.runs || []).filter(run => run.source === 'async').slice(0, 6)

  useEffect(() => {
    if (!selectedPath && files[0]) setSelectedPath(files[0].path)
    if (selectedPath && !files.some(file => file.path === selectedPath)) setSelectedPath(files[0]?.path || '')
  }, [files, selectedPath])

  const diff = review?.diff || ''
  const selectedDiff = diffForFile(diff, selected?.path) || (files.length === 1 ? diff : '')
  const diffLines = selectedDiff ? selectedDiff.split(/\r?\n/) : []
  const toggleMission = (id: string) => setOpenMissions(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next })
  const toggleFileGroup = (group: string) => setOpenFileGroups(previous => { const next = new Set(previous); next.has(group) ? next.delete(group) : next.add(group); return next })

  return <div className="review-workbench">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <span className="review-meta"><GitCompare className="w-3.5 h-3.5" />{review?.branch ? `分支 ${review.branch}` : isLoading ? '正在读取仓库…' : '尚未连接仓库'}</span>
      <button type="button" className="btn-ghost min-h-11 inline-flex items-center gap-2" onClick={() => void mutate()} disabled={isLoading}><RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />刷新快照</button>
    </div>

      <section className="review-hero-card"><div><span className="review-eyebrow">改动与验收 · SYSTEM REVIEW / EVIDENCE</span><h2>当前项目的真实状态</h2><p>仓库改动和工作记录分开呈现，未跟踪文件会按用途折叠，避免把工作空间噪声误认为源码问题。</p></div><div className="review-project-path"><GitBranch className="w-4 h-4" /><span>{review?.root || 'D:\\pi-web'}</span></div></section>
      {error && <div className="review-alert" role="alert"><CircleAlert className="w-4 h-4" />读取 Git 改动失败，请稍后重试。</div>}
      {isLoading && <div className="review-loading" role="status">正在整理文件改动…</div>}
      {!isLoading && !error && review?.error && <div className="review-alert" role="alert"><CircleAlert className="w-4 h-4" />仓库输出过大，暂时无法完整读取；请刷新后继续。</div>}
      {!isLoading && !error && review && !review.isRepo && <div className="review-empty"><GitCompare className="w-7 h-7" /><h2>这里还不是 Git 仓库</h2><p>当前工作台没有找到可验收的源码仓库。</p></div>}

      {!isLoading && !error && review?.isRepo && !review.error && <>
        {review.filesTruncated && <p className="review-alert" role="status">共 {review.filesTotal} 项改动；当前仅预览前 {files.length} 项，行数统计也仅对应预览部分。</p>}
        {verification.state === 'stale' && <p className="review-alert" role="status">上次检查后源码已变化，结果已过期，需要重新验证。</p>}
        <section className="review-summary" aria-label="改动摘要"><div><span className="review-summary-label">改动文件</span><strong>{files.length}</strong><small>{files.filter(file => file.status === 'untracked').length} 项未跟踪</small></div><div><span className="review-summary-label">新增行</span><strong className="text-pi-success">+{summary.additions}</strong></div><div><span className="review-summary-label">删除行</span><strong className="text-pi-danger">-{summary.deletions}</strong></div><div className="review-summary-verification"><span className="review-summary-label">验收状态</span><span className={`review-verification review-verification-${verification.state}`}><span className="review-status-dot" />{verification.state === 'passed' ? '已通过' : verification.state === 'failed' ? '有问题' : verification.state === 'running' ? '进行中' : verification.state === 'stale' ? '证据已过期' : '尚未执行'}</span><small>只显示真实执行结果</small></div></section>

        <div className="review-workbench-grid"><section className="review-file-panel" aria-label="改动文件"><div className="review-section-head"><span>改动文件</span><span className="text-pi-dim2">{files.length} 项</span></div>{groupedFiles.map(([group, groupFiles]) => { const open = openFileGroups.has(group); return <div key={group} className="review-file-group"><button type="button" className="review-file-group-label" aria-expanded={open} onClick={() => toggleFileGroup(group)}><span className="inline-flex items-center gap-1.5">{open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}{group}</span><span>{groupFiles.length}</span></button>{open && groupFiles.map(file => <button type="button" key={file.path} className={`review-file-row ${selected?.path === file.path ? 'is-selected' : ''}`} onClick={() => setSelectedPath(file.path)}><FileCode2 className="w-4 h-4 shrink-0" /><span className="review-file-name" title={file.path}>{file.path}</span><span className={`review-file-status review-file-status-${file.status}`}>{statusLabel(file.status)}</span><span className="review-file-count">{file.additions == null ? '—' : `+${file.additions}`} / {file.deletions == null ? '—' : `-${file.deletions}`}</span></button>)}</div> })}{files.length === 0 && <p className="review-panel-empty">工作区干净，暂时没有待验收改动。</p>}</section><section className="review-diff-panel" aria-label="差异预览"><div className="review-section-head"><span className="truncate">{selected?.path || '差异预览'}</span>{review.diffTruncated && <span className="review-diff-truncated">预览已截断</span>}</div>{selected?.status === 'untracked' && <p className="review-panel-empty">这是未跟踪文件，当前只展示状态。加入版本控制后才会生成逐行差异。</p>}{!selected && files.length === 0 && <p className="review-panel-empty">没有差异可预览。</p>}{selected && selected.status !== 'untracked' && <pre className="review-diff"><code>{diffLines.map((line, index) => <span className={diffLineClass(line)} key={`${index}-${line}`}>{line || ' '}{'\n'}</span>)}</code></pre>}</section></div>

        <section className="review-evidence-grid"><div className="review-evidence-card"><div className="review-evidence-heading"><div><span className="review-eyebrow">AIBODY / CONTINUITY</span><h2><Layers3 className="w-4 h-4" />系统脉络</h2><p>{aibody?.principle || '宿主、母体和表现三层共同构成元枢的连续性。'}</p></div><span className="review-evidence-live">{aibodyError ? '读取失败，请稍后重试' : aibody?.observedAt ? '运行记录与文件读数' : aibody ? '代码存在性映射' : '读取中…'}</span></div><p className="text-xs text-pi-dim break-words">这里的数量表示有读数，不代表健康检查通过。情绪取最近记录会话，不一定是当前打开的聊天。{aibody?.observationContext?.sessionId && ` 会话：${aibody.observationContext.sessionId}`} {aibody?.observedAt && `读取时间：${formatDate(aibody.observedAt)}`}</p><div className="review-layer-stack">{(aibody?.layers || []).map(layer => <LayerCard key={layer.id} layer={layer} />)}</div>{aibody?.theory?.length ? <div className="review-theory-row">{aibody.theory.map(item => <div key={item.id}><strong>{item.label}</strong><span>{item.detail}</span>{item.evidence?.length ? <code>{item.evidence.join(' · ')}</code> : null}</div>)}</div> : null}<div className="review-theory-row" aria-label="陪伴与进化边界"><div><strong>真实陪伴</strong><span>{aibody?.companionship?.continuity || '连续性未记录'}。{aibody?.companionship?.memory || '记忆边界未记录'}。{aibody?.companionship?.boundary || '边界未记录'}。</span></div><div><strong>可治理进化</strong><span>{aibody?.evolution?.mode || '进化方式未记录'}：{aibody?.evolution?.humanApproval ? '人工审批' : '审批执行情况未核实'}，{aibody?.evolution?.rollback ? '支持回滚' : '本页未验证回滚能力'}。可调整：{aibody?.evolution?.scope?.join('、') || '范围未记录'}；保护：{aibody?.evolution?.protected?.join('、') || '边界未记录'}。</span></div></div></div>

          <div className="review-evidence-card"><div className="review-evidence-heading"><div><span className="review-eyebrow">AGENT TRACE / VISIBLE</span><h2><Bot className="w-4 h-4" />子智能体工作记录</h2><p>每次任务都保留状态、模型、工具、验收和失败原因，方便回看为什么这样做。</p></div>{history?.counts && <span className="review-evidence-live">{history.counts.runs} 次运行 · {history.counts.failed} 次失败</span>}</div><div className="review-mission-list">{missions.slice(0, 6).map(mission => { const open = openMissions.has(mission.id); return <article key={mission.id} className="review-mission-card"><button type="button" className="review-mission-toggle" onClick={() => toggleMission(mission.id)}><span className="review-mission-icon"><PackageOpen className="w-4 h-4" /></span><span className="min-w-0 flex-1"><strong>{mission.title}</strong><small>{mission.objective || '没有记录目标'} · {mission.runs.length} 次运行 · {mission.artifacts.length} 个产物</small></span><span className={`review-run-badge review-run-badge-${runTone(mission.status)}`}>{runLabel(mission.status)}</span>{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button>{open && <div className="review-mission-detail">{mission.summary && <p className="review-mission-summary">{mission.summary}</p>}{mission.runs.slice(0, 4).map(run => <RunRecord key={run.runId} run={run} />)}{mission.artifacts.length > 0 && <div className="review-artifact-list">{mission.artifacts.map(artifact => <span key={artifact.path}><ExternalLink className="w-3 h-3" />{artifact.name}</span>)}</div>}</div>}</article> })}{recentRuns.length > 0 && <div className="review-background-runs"><span>后台异步记录</span>{recentRuns.map(run => <RunRecord key={run.runId} run={run} />)}</div>}{!history && <div className="review-panel-empty">正在读取子智能体记录…</div>}{history && !missions.length && !recentRuns.length && <div className="review-panel-empty">还没有可展示的子智能体记录。</div>}</div></div></section>

        <section className="review-verification-panel" aria-label="验收状态"><div><div className="review-section-head"><span>验收状态</span><span className="review-verification review-verification-unknown">只展示真实结果</span></div><p className="review-verification-copy">{verification.checks.length ? `本地检查记录 · ${formatDate(verification.recordedAt)}。源码变化后自动标记过期；不代表真实视频生成或安装包已验收。` : '还没有执行记录。在项目目录运行 node scripts/verify-workbench.mjs 后，结果会自动显示。'}</p>{verification.checks.map(check => <p key={check.name} className="text-sm text-pi-text">{({ unit: '全量测试', types: '类型检查', build: '前端构建' } as Record<string, string>)[check.name || ''] || check.name}：{check.state === 'passed' ? '通过' : '失败'} · {formatDuration(check.durationMs)}</p>)}</div><button type="button" className={`btn-ghost review-ack-button ${acknowledged ? 'is-acknowledged' : ''}`} onClick={() => setAcknowledged(true)}><Check className="w-4 h-4" />{acknowledged ? '已记录我已查看' : '记录我已查看'}</button></section>
      </>}
  </div>
}

export default ReviewPanel
