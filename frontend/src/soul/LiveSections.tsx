import { useState } from 'react'
import useSWR from 'swr'
import { AIBodyApi, SkillsApi, TeamRunApi } from '../api'
import { KnowledgeApi, knowledgePolling } from '../knowledge/api'
import { useCompanionContext } from '../components/xiaoyu/CompanionProvider'
import { Block, date, LoadState } from './shared'
import { diagnosticMessages } from './diagnostics.mjs'

export function Rhythm() {
  const c = useCompanionContext(), [saving,setSaving] = useState(false)
  const labels = {observed:'已观测',historical:'历史记录',stale:'连接已过期',unavailable:'暂无可靠观测'}
  return <>
    <Block title="情绪与陪伴节律" hint="最近一次情绪观测，随互动变化。">
      <dl className="soul-facts"><div><dt>观测状态</dt><dd>{labels[c.emotion.status]}</dd></div><div><dt>最近情绪</dt><dd>{c.emotion.meta.label}</dd></div><div><dt>记录时间</dt><dd>{date(c.emotion.snapshot?.observedAt)}</dd></div></dl>
      <label className="soul-check"><input type="checkbox" checked={c.dnd} disabled={saving || !c.preferencesReady} onChange={async e => {setSaving(true); try {await c.setDnd(e.target.checked)} finally {setSaving(false)}}} />陪伴免打扰</label>
      <p className="soul-hint">开启后公仔不再主动打扰，对话和任务照常。</p>
      {!c.preferencesReady && <p role="status">正在等待可靠的偏好设置，暂不允许修改。</p>}
      {c.feedback && <p role="status">{c.feedback}</p>}
    </Block>
    <Block title="想调整情绪？" hint="情绪来自互动，不能手动设数值；想长期调整性格，去性格基因提提案。"><a href="#/chat">回到对话，打开右上角情绪潮汐</a></Block>
  </>
}

export function Learning() {
  const skills = useSWR('skills', SkillsApi.list)
  const knowledge = useSWR('knowledge-status', KnowledgeApi.status, knowledgePolling)
  return <>
    <Block title="学习与经验" hint="文章接收、提炼和批准都在知识页。有验证产物才算学会。">
      <LoadState error={knowledge.error} loading={knowledge.isLoading} retry={knowledge.mutate} />
      {knowledge.data && <dl className="soul-facts"><div><dt>待核查</dt><dd>{knowledge.data.summary.counts.review_required || 0}</dd></div><div><dt>已入库（不等于已验证）</dt><dd>{knowledge.data.summary.counts.committed || 0}</dd></div><div><dt>等待条件</dt><dd>{knowledge.data.summary.counts.blocked || 0}</dd></div></dl>}
      <a href="#/apps">进入知识页处理学习与经验</a>
    </Block>
    <Block title="已发现的技能" hint="已安装的技能目录。">
      <LoadState error={skills.error} loading={skills.isLoading} retry={skills.mutate} />
      {skills.data && <p>目录中共有 {skills.data.skills.length} 项。<a href="#/apps">进入知识页管理和检索</a></p>}
      {diagnosticMessages(skills.data?.diagnostics).map((message: string,i: number) => <p className="soul-notice" key={i}>{message}</p>)}
    </Block>
  </>
}

export function Mother() {
  const state = useSWR('aibody-overview', AIBodyApi.overview, {refreshInterval:120000})
  return <>
    <LoadState error={state.error} loading={state.isLoading} retry={state.mutate} />
    <p className="soul-hint">{state.data?.principle || '读取母体与配套层的实际记录。'}</p>
    {state.data && <p className="soul-hint">观测时间：{date(state.data.observedAt || state.data.updatedAt)} · 范围：{state.data.observationContext?.scope || '未提供'}</p>}
    <Block title="母体配套概览" hint="详细观测与审计在工作台。">
      {state.data?.layers.map(layer => <article key={layer.id} className="soul-record"><h4>{layer.label}</h4><p>{layer.summary}</p><p className="soul-hint">{layer.modules.length} 项记录 · {layer.modules.filter(m => m.available).length} 项资源可读取（不代表已运行）</p></article>)}
      <a href="#/review">查看母体观测与审计详情</a>
    </Block>
  </>
}
export function Team() {
  const state = useSWR('team-run', TeamRunApi.get, {refreshInterval:10000})
  const labels: Record<string,string> = {launching:'正在启动',running:'执行中',completed:'执行已结束，仍需核对验收',failed:'执行失败',interrupted:'运行中断或待确认',blocked:'启动受阻',stopping:'正在停止',stopped:'已停止'}
  return <Block title="天团与培养" hint="发起、停止与验收在工作台处理。">
    <LoadState error={state.error} loading={state.isLoading} retry={state.mutate} />
    {state.data && <><p>{state.data.launch ? labels[state.data.launch.status] || '状态待核对' : '暂无启动器记录'}</p>{state.data.launch?.task && <p className="soul-preserve">{state.data.launch.task}</p>}{state.data.hint && <p className="soul-hint">{state.data.hint}</p>}</>}
    <div className="soul-actions"><a href="#/team">进入工作台 · 天团协作</a></div>
  </Block>
}
