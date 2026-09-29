import { useState } from 'react'
import useSWR from 'swr'
import { AIBodyApi, SkillsApi } from '../api'
import { TeamRunView } from '../components/TeamRunView'
import LearningIntakePanel from '../components/LearningIntakePanel'
import { useCompanionContext } from '../components/xiaoyu/CompanionProvider'
import { Block, date, LoadState } from './shared'

export function Rhythm() {
  const c = useCompanionContext(), [saving,setSaving] = useState(false)
  const labels = {observed:'已观测',historical:'历史记录',stale:'连接已过期',unavailable:'暂无可靠观测'}
  return <>
    <Block title="情绪与陪伴节律" hint="情绪是最近一次全局观测，不是固定人格，也不代表当前会话独有的感受。">
      <dl className="soul-facts"><div><dt>观测状态</dt><dd>{labels[c.emotion.status]}</dd></div><div><dt>最近情绪</dt><dd>{c.emotion.meta.label}</dd></div><div><dt>记录时间</dt><dd>{date(c.emotion.snapshot?.observedAt)}</dd></div></dl>
      <label className="soul-check"><input type="checkbox" checked={c.dnd} disabled={saving || !c.preferencesReady} onChange={async e => {setSaving(true); try {await c.setDnd(e.target.checked)} finally {setSaving(false)}}} />陪伴免打扰</label>
      <p className="soul-hint">开启后暂停公仔主动互动；不停止你发起的对话和任务。与现有公仔设置同步。</p>
      {!c.preferencesReady && <p role="status">正在等待可靠的偏好设置，暂不允许修改。</p>}
      {c.feedback && <p role="status">{c.feedback}</p>}
    </Block>
    <Block title="调节边界" hint="不提供直接写入情绪数值的滑杆。情绪来自互动；长期性格调整请到性格基因提出带证据的提案。"><a href="#/board">到工作台查看情绪潮汐与互动记录</a></Block>
  </>
}

export function Learning() {
  const skills = useSWR('soul-skills', SkillsApi.list)
  return <>
    <Block title="学习与经验" hint="学习接收、待提炼记录与经验库共用原有流程。收到文章不等于已经掌握；有验证产物才算完成。"><LearningIntakePanel /></Block>
    <Block title="已发现的技能" hint="这里是可用技能的目录，不代表每个技能都通过实测。">
      <LoadState error={skills.error} loading={skills.isLoading} retry={skills.mutate} />
      {skills.data && <p>目录中共有 {skills.data.skills.length} 项。<a href="#/apps">进入知识页管理和检索</a></p>}
      {skills.data?.diagnostics?.map((d,i) => <p className="soul-notice" key={i}>{d}</p>)}
    </Block>
  </>
}

export function Mother() {
  const state = useSWR('soul-aibody', AIBodyApi.overview, {refreshInterval:30000})
  return <>
    <LoadState error={state.error} loading={state.isLoading} retry={state.mutate} />
    <p className="soul-hint">{state.data?.principle || '读取母体与配套层的实际记录。'} 文件存在不等于能力已运行，配置声明不等于审计通过。</p>
    {state.data && <p className="soul-hint">观测时间：{date(state.data.observedAt || state.data.updatedAt)} · 范围：{state.data.observationContext?.scope || '未提供'}</p>}
    {state.data?.layers.map(layer => <Block key={layer.id} title={layer.label} hint={layer.summary}>
      {layer.modules.map((m,i) => <article className="soul-record" key={`${m.key || m.path}-${i}`}><h4>{m.label}</h4><p>{m.statusLabel || (m.available ? '资源可读取，运行状态未提供' : '资源不可读取')}</p>{m.summary && <p>{m.summary}</p>}<details><summary>查看来源与观测详情</summary><p>{m.path}</p><pre>{JSON.stringify(m.details ?? {status:m.status || 'unknown'},null,2)}</pre></details></article>)}
    </Block>)}
    <Block title="协作与治理边界" hint="培养中心只连接元枢已有能力，不启动外部系统同步，不开放自动改写人格。"><a href="#/engine">查看引擎分工与实际运行诊断</a></Block>
  </>
}
export function Team() {
  return <><p className="soul-hint">复用天团任务入口和运行记录。角色只继承有限上下文；任务产物、人格培养和基因审批是不同流程。</p><TeamRunView /></>
}
