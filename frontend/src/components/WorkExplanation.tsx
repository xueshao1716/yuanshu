import { Bot, ChevronDown, CircleCheck, CircleHelp, FileBox, TriangleAlert } from 'lucide-react'
import type { RunSummary } from '../api'
import { workRole, workState, workTime, workTool } from '../lib/work-explanation'
import { useProcessVisibility } from '../hooks/useProcessVisibility'

const verificationLabels = { passed: '已记录检查通过', failed: '有检查未通过', reported: '仅有模型自报', not_observed: '尚无检查记录' }

export default function WorkExplanation({ run }: { run: RunSummary }) {
  const [showEvidence, toggleEvidence] = useProcessVisibility('evidence')
  const work = run.explanation
  if (!work) return <p className="text-sm text-pi-dim py-3">这条历史记录尚无工作说明，可打开会话查看原始结果。</p>
  const verification = work.verification
  const issue = ['failed', 'interrupted'].includes(work.status.code) || verification.state === 'failed'
  const Icon = issue ? TriangleAlert : verification.state === 'passed' ? CircleCheck : CircleHelp
  return <section className="min-w-0 rounded-pi-lg border border-pi-border-soft bg-pi-bg1/80 px-3 sm:px-4 py-3 text-sm" aria-label="工作说明">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <span className={`font-medium ${issue ? 'text-pi-danger' : 'text-pi-text'}`}>{work.status.label}</span>
      <time className="text-xs text-pi-dim tabular-nums" dateTime={work.updatedAt || undefined}>{workTime(work.updatedAt)}</time>
    </div>
    <p className="mt-1.5 text-pi-text break-words leading-relaxed line-clamp-2" title={work.goal}>{work.goal}</p>
    <p className="mt-1 text-xs text-pi-dim break-words">{work.status.detail}</p>
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-pi-dim">
      <span className={`inline-flex items-center gap-1.5 ${verification.state === 'failed' ? 'text-pi-danger' : ''}`}><Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{verificationLabels[verification.state]}</span>
      <span>工具记录 {work.tools.count}</span><span>子任务 {work.subagents.count}</span><span>产物记录 {work.artifacts.count}</span>
    </div>
    {work.problem && <p role="note" className="mt-3 break-words text-pi-danger leading-relaxed">遇到的问题：{work.problem}</p>}
    <details className="group mt-2" open={showEvidence}>
      <summary onClick={event => { event.preventDefault(); toggleEvidence() }} aria-expanded={showEvidence} title="对所有工作说明生效，此设备会记住选择" className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-pi-accent select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 rounded-pi-sm">
        <ChevronDown className="h-4 w-4 group-open:rotate-180" aria-hidden="true" />过程与依据
        <span className="ml-auto text-xs text-pi-dim">{showEvidence ? '隐藏' : '显示'}</span>
      </summary>
      <div className="min-w-0 border-t border-pi-border-soft pt-3 space-y-4">
        <dl className="grid grid-cols-1 sm:grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-2 leading-relaxed">
          <dt className="text-pi-dim">任务目标</dt><dd className="min-w-0 text-pi-text break-words">{work.goal}</dd>
          <dt className="text-pi-dim">执行引擎</dt><dd className="min-w-0 text-pi-text break-words">{work.executor.engine}</dd>
          <dt className="text-pi-dim">执行模型</dt><dd className="min-w-0 text-pi-text break-words">{work.executor.model}</dd>
          <dt className="text-pi-dim">已有依据</dt><dd className="space-y-1 min-w-0 text-pi-text break-words">{work.basis.map((reason, i) => <p key={i}>{reason}</p>)}</dd>
          <dt className="text-pi-dim">记忆写入</dt><dd className="text-pi-text break-words">{work.memory.writes ? `${work.memory.writes} 条写入记录` : '本轮没有写入记录'}{work.memory.summary && <p className="text-pi-dim">{work.memory.summary}</p>}</dd>
        </dl>
        <div><h3 className="font-medium text-pi-text mb-2">工具执行</h3>
          {!work.tools.count && <p className="text-pi-dim">本轮没有工具执行记录。</p>}
          <ul className="space-y-2">{work.tools.items.map(tool => <li key={tool.id} className="flex flex-wrap gap-x-3 gap-y-1 min-w-0">
            <span className="text-pi-text break-words" title={tool.name}>{workTool(tool.name)}</span><span className={tool.status === 'error' ? 'text-pi-danger' : 'text-pi-dim'}>{workState(tool.status)}</span><time className="text-xs text-pi-dim tabular-nums sm:ml-auto">{workTime(tool.at)}</time>
          </li>)}</ul>{work.tools.count > work.tools.items.length && <p className="mt-2 text-xs text-pi-dim">展示最近 {work.tools.items.length} 条，共 {work.tools.count} 条。</p>}
        </div>
        <div><h3 className="font-medium text-pi-text mb-2">子智能体协作</h3>
          {!work.subagents.count && <p className="text-pi-dim">本轮没有委派记录；部分任务由主角色直接处理。</p>}
          <div className="space-y-3">{work.subagents.items.map(child => <article key={child.id} className="border-l-2 border-pi-border-soft pl-3 min-w-0">
            <div className="flex flex-wrap gap-2 items-center"><Bot className="h-4 w-4 text-pi-accent" aria-hidden="true" /><h4 className="font-medium text-pi-text">{workRole(child.role)}</h4><span className="text-xs text-pi-dim">{workState(child.status)}</span></div>
            <p className="mt-1 text-pi-text break-words">{child.task || '任务未记录'}</p>
            <p className="text-xs text-pi-dim break-words mt-1">{child.model || '模型未记录'} · {workTime(child.at)}</p>
            {child.summary && <p className="mt-2 text-pi-text break-words">返回结论：{child.summary}</p>}
            {child.error && <p className="mt-1 text-pi-danger break-words">{child.error}</p>}
            {!!child.evidence.length && <ul className="mt-2 space-y-1 text-pi-dim">{child.evidence.map((item, i) => <li key={i} className="break-words">自报依据：{item}</li>)}</ul>}
            {child.confidence !== null && <p className="text-xs text-pi-dim mt-1">自评把握 {Math.round(child.confidence * 100)}%，不代表系统已验证。</p>}
          </article>)}</div>
          {work.subagents.count > work.subagents.items.length && <p className="mt-2 text-xs text-pi-dim">展示最近 {work.subagents.items.length} 个子任务，共 {work.subagents.count} 个。</p>}
        </div>
        <div><h3 className="font-medium text-pi-text mb-2">产物与交付</h3>
          {!work.artifacts.count ? <p className="text-pi-dim">尚无产物记录。文字回复请在会话中查看。</p> : <><ul className="space-y-2">{work.artifacts.items.map(artifact => <li key={artifact.id} className="flex gap-2 items-start min-w-0"><FileBox className="h-4 w-4 mt-0.5 text-pi-accent shrink-0" aria-hidden="true" /><div className="min-w-0"><p className="text-pi-text break-words">{artifact.name}</p><p className="text-xs text-pi-dim break-all mt-1">{artifact.path || '位置未记录'}</p></div></li>)}</ul><p className="mt-2 text-xs text-pi-dim">记录了产物位置，是否可打开、可播放仍需检查。</p><a className="inline-flex items-center min-h-11 text-pi-accent" href="#/assets">打开资产库</a></>}
          {work.artifacts.count > work.artifacts.items.length && <p className="text-xs text-pi-dim">展示最近 {work.artifacts.items.length} 个，共 {work.artifacts.count} 个。</p>}
        </div>
        <div><h3 className="font-medium text-pi-text mb-2">检查与验收</h3><p className="text-pi-dim">{verificationLabels[verification.state]}。本轮结束、文件已生成、人工已验收是不同的状态。</p>
          <ul className="mt-2 space-y-1">{verification.items.map((check, i) => <li key={i} className="text-pi-text break-words">{check.name} · {workState(check.state)}</li>)}</ul>
        </div>
        {!!work.notes.length && <div><h3 className="font-medium text-pi-text mb-2">系统提示记录</h3><ul className="space-y-1 text-pi-dim">{work.notes.map((note, i) => <li className="break-words" key={i}>{note}</li>)}</ul></div>}
        <p className="text-xs text-pi-dim leading-relaxed">{work.coverage}</p>
      </div>
    </details>
    <p className="pt-2 border-t border-pi-border-soft text-xs text-pi-dim leading-relaxed break-words"><span className="text-pi-text font-medium">接下来：</span>{work.nextStep}</p>
  </section>
}
