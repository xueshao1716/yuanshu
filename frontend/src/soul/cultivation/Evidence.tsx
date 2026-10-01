import type { Experience, ExperienceCoverage } from './api'
import { date } from '../shared'

export function EvidenceSummary({items,coverage,stale}:{items:Experience[];coverage?:ExperienceCoverage;stale:boolean}) {
  if(stale)return <p className="soul-notice" role="status">旧数据：本次读取失败，以下仅保留上次成功读取的记录。
    {coverage?`记录读取时间：${date(coverage.observedAt)}。`:'上次读取时间未提供。'}请重新读取后再处理；本次不计算摘要。</p>
  if(!coverage||items.some(item=>!item.observation))return <p className="soul-hint">服务端未提供证据观察字段或分页范围，暂不计算摘要；现有知识记录仍可查看。</p>
  return <section aria-label="本页证据摘要">
    <dl className="cultivation-evidence-counts">
      <div><dt>本页候选</dt><dd>{items.length}</dd></div>
      <div><dt>带补证记录</dt><dd>{items.filter(item=>item.observation?.resolutionRecorded).length}</dd></div>
      <div><dt>关联失效</dt><dd>{items.filter(item=>item.observation?.linkState==='invalidated').length}</dd></div>
    </dl>
    <p className="soul-hint">仅统计本页，分类可重叠，不代表全部历史。{coverage.hasMore?'还有后续页。':'本次列表已到末页。'}
      记录读取时间：{date(coverage.observedAt)}；不是来源核验时间。记录可能随任务进展变化。</p>
  </section>
}

export default function Evidence({item}:{item:Experience}) {
  const observation=item.observation
  if(!observation)return <><p>个体 {item.agentId}</p><p className="soul-hint">此记录未提供证据观察字段；无法展示完整来源链，请查看原知识记录。</p></>
  const {lineage,latestDecisions}=observation
  return <div className="cultivation-evidence">
    <dl className="cultivation-lineage" aria-label="记录来源链">
      <div><dt>个体</dt><dd>{lineage.agentId}</dd></div>
      <div><dt>设计版本</dt><dd>{lineage.designId??'未记录'}</dd></div>
      <div><dt>运行任务</dt><dd>{lineage.runId}</dd></div>
      <div><dt>知识候选</dt><dd>{lineage.knowledgeJobId}</dd></div>
    </dl>
    {observation.linkState==='invalidated'?<p className="soul-notice">运行与知识关联失效：记录缺失或内容不一致。以上标识仅来自运行记录，不展示补证和采用状态。</p>:<>
      {observation.resolutionRecorded?<><p>已有补证记录，不代表来源当前有效。</p><dl className="cultivation-lineage"><div><dt>补证任务</dt><dd>{lineage.resolutionJobId??'未记录'}</dd></div><div><dt>知识条目</dt><dd>{lineage.entryId??'未记录'}</dd></div></dl></>:<p>尚无补证记录，模型生成内容仍为待核查候选。</p>}
      <h5>各范围最近的历史决定</h5>
      {!latestDecisions.length?<p>尚无采用或退役记录。</p>:<ul>{latestDecisions.map(row=><li key={row.scope}>
        {row.scope==='mother'?'母体':`原个体 ${row.scope}`}：曾{row.decision==='adopt'?'采用':'退役'} · 版本 {row.version}
        <small>{row.actor.kind==='human'?'人工授权':row.actor.kind==='mother'?'母体决定':'决定者未记录'} · {date(row.at)}</small>
      </li>)}</ul>}
    </>}
    <p className="soul-hint">{observation.sourceCurrent==='not_checked'?'来源当前有效性未在本页重核。':'来源核验状态未知。'}历史采用不代表当前允许使用；采用时仍由服务器复核。用户认可：未记录。</p>
  </div>
}
