import useSWR from 'swr'
import { ArrowRight } from 'lucide-react'
import { SoulApi } from './api'
import { Block, LoadState } from './shared'
export const sections = [
  ['overview','培养总览','从真实记录开始，找到下一步'], ['identity','身份与表达','身份、价值观、关系与边界'],
  ['genes','性格基因','长期基线、互动表现与提案'], ['rhythm','情绪与节律','情绪观测、主动陪伴与免打扰'],
  ['memory','记忆与关系','回忆检索、来源与记忆快照'], ['learning','学习与技能','学习接收、经验与技能目录'],
  ['mother','aibody 母体','宿主、生命层与表达层的实况'], ['team','天团协作','角色分工、任务与交付记录'],
  ['cultivation','智能体培养','小语的设计、个体、运行与学习证据'],
  ['voice','声音与形象','外貌、服装、声音与现有立绘'], ['history','审批与回退','修订、人工确认与安全撤回'],
] as const
export type Section = typeof sections[number][0]
export default function Overview({open}: {open:(section:Section)=>void}) {
  const persona = useSWR('soul-persona', SoulApi.persona), genes = useSWR('soul-genome', SoulApi.genome)
  return <>
    <Block title="一起培养，不替你决定" hint="调整表达，积累经历，观察改变。长期人格与基因变更需要理由、证据和你的确认；页面不会自行培养出一个评分。">
      <LoadState error={persona.error} loading={persona.isLoading} retry={persona.mutate} />
      <LoadState error={genes.error} loading={genes.isLoading} retry={genes.mutate} />
      <dl className="soul-facts"><div><dt>人格来源</dt><dd>{persona.error ? '读取失败' : !persona.data ? '读取中' : persona.data.source === 'file' && !persona.data.problems.length ? String(persona.data.definition.name || '现有人格文件') : '来源需修复'}</dd></div><div><dt>待审基因提案</dt><dd>{genes.error ? '读取失败' : genes.data ? genes.data.proposals.filter(p=>p.status==='pending').length : '读取中'}</dd></div><div><dt>人格修订记录</dt><dd>{persona.error ? '读取失败' : persona.data?.history.length ?? '读取中'}</dd></div></dl>
      {!!persona.data?.problems.length && <p role="alert" className="soul-notice">{persona.data.problems.join('；')}。恢复前禁止保存。</p>}
    </Block>
    <Block title="培养授权入口" hint="如果你要给小语开放培养权限，请从这里进入；进入后默认就是“授权与资源”页。">
      <button className="soul-primary-action" onClick={()=>open('cultivation')}>
        <strong>进入培养授权</strong><span>授权与资源（先从这里）</span><ArrowRight size={18} aria-hidden="true" />
      </button>
    </Block>
    <div className="soul-directory">{sections.slice(1).map(([id,title,hint]) => <button key={id} onClick={()=>open(id)}><strong>{title}</strong><span>{hint}</span><span aria-hidden="true"><ArrowRight size={18}/></span></button>)}</div>
  </>
}
