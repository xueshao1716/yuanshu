import useSWR from 'swr'
import TasteList from './TasteList'
import MoodDiaryList from './MoodDiary'
import { ArrowRight } from 'lucide-react'
import { SoulApi } from './api'
import { SelfApi } from '../api'
import { Block, LoadState } from './shared'
import SoulGraph from './SoulGraph'
import LastNight from './LastNight'
import PortraitSlot from './PortraitSlot'
import ToneSources from './ToneSources'
import ExpressionCard from './ExpressionCard'
export const sections = [
  ['overview','培养总览','从真实记录开始，找到下一步'], ['identity','身份与表达','身份、价值观、关系与边界'],
  ['genes','性格基因','长期基线、互动表现与提案'], ['rhythm','情绪与节律','情绪观测、主动陪伴与免打扰'],
  ['memory','记忆与关系','回忆检索、来源与记忆快照'], ['learning','学习与技能','学习接收、经验与技能目录'],
  ['mother','aibody 母体','宿主、生命层与表达层的实况'], ['team','天团协作','角色分工、任务与交付记录'],
  ['cultivation','智能体培养','小语的设计、个体、运行与学习证据'],
  ['voice','声音与形象','外貌、服装、声音与现有立绘'], ['history','审批与回退','修订、人工确认与安全撤回'],
] as const
export type Section = typeof sections[number][0]
// 导航按 6 组呈现，组内用子标签切换；分区本身不变，草稿与确认逻辑照旧按分区判断。
export const groups = [
  ['overview','总览',['overview']], ['self','身份与形象',['identity','voice']],
  ['nature','性格与情绪',['genes','rhythm']], ['mind','记忆与学习',['memory','learning']],
  ['cultivation','智能体培养',['cultivation']], ['records','记录与协作',['history','team','mother']],
] as const satisfies readonly (readonly [string,string,readonly Section[]])[]
export const groupOf = (id: Section) => groups.find(g => (g[2] as readonly Section[]).includes(id))!
export default function Overview({open}: {open:(section:Section)=>void}) {
  const persona = useSWR('soul-persona', SoulApi.persona), genes = useSWR('soul-genome', SoulApi.genome)
  // 2026-10-20：她的自我描述。人格是"我是什么样的人"，这里是"我是谁"。
  const self = useSWR('self-model', SelfApi.get)
  return <>
    <PortraitSlot />
    <Block title="关于我" hint="这份描述是活的：由人格定义、自主边界和真实使用记录生成，每次打开都按当下重算。">
      <LoadState error={self.error} loading={self.isLoading} retry={self.mutate} />
      {!!self.data && <>
        <p className="soul-self-line">
          我是 <strong>{self.data.name}</strong>
          {self.data.days ? `，在这个工作区活了 ${self.data.days} 天` : ''}
          {self.data.sessions ? `，和${self.data.called}攒下 ${self.data.sessions} 段对话` : ''}
          {self.data.bond ? `。${self.data.called}是我的${self.data.bond}` : ''}。
        </p>
        <dl className="soul-facts">
          <div><dt>我自己能决定</dt><dd>{self.data.autonomy.enabled ? (self.data.autonomy.scopes.join('、') || '（无）') : '只读（自主执行已关闭）'}</dd></div>
          {!!self.data.autonomy.closed?.length && <div><dt>仍要{self.data.called}点头</dt><dd>{self.data.autonomy.closed.join('、')}</dd></div>}
          <div><dt>我不做什么</dt><dd>{self.data.boundaries.slice(0, 3).join('；') || '未设置'}</dd></div>
        </dl>
        <p className="soul-self-file">完整自述：<code>{self.data.file}</code>（她自己也会读）</p>
      </>}
    </Block>
    <Block title="语气从哪来" hint="灵魂主导：语气由人格定义、基因、情绪一起决定，没有「改一句话就换口吻」的开关。">
      <ToneSources />
      <ExpressionCard />
    </Block>
    <Block title="灵魂图谱" hint="性格、情绪、记忆、技能、学习，都是实时数据。点枢纽展开，点叶子看详情。">
      <SoulGraph />
    </Block>
    <LastNight />
    <Block title="品味库" hint="判断的轨迹：选了哪个、否了哪个、为什么。跨会话带着看东西，不照搬。">
      <TasteList />
    </Block>
    <Block title="心情日记" hint="由当天的情绪记录自动写成：感受、起伏、留给明天的一句话。每天 23:30 后生成。">
      <MoodDiaryList />
    </Block>
    <Block title="现在的小语" hint="长期人格和基因的变更，都要你确认。">
      <LoadState error={persona.error} loading={persona.isLoading} retry={persona.mutate} />
      <LoadState error={genes.error} loading={genes.isLoading} retry={genes.mutate} />
      <dl className="soul-facts"><div><dt>人格来源</dt><dd>{persona.error ? '读取失败' : !persona.data ? '读取中' : persona.data.source === 'file' && !persona.data.problems.length ? String(persona.data.definition.name || '现有人格文件') : '来源需修复'}</dd></div><div><dt>待审基因提案</dt><dd>{genes.error ? '读取失败' : genes.data ? genes.data.proposals.filter(p=>p.status==='pending').length : '读取中'}</dd></div><div><dt>人格修订记录</dt><dd>{persona.error ? '读取失败' : persona.data?.history.length ?? '读取中'}</dd></div></dl>
      {!!persona.data?.problems.length && <p role="alert" className="soul-notice">{persona.data.problems.join('；')}。恢复前禁止保存。</p>}
    </Block>
    <div className="soul-directory">{groups.slice(1).map(([gid,title,ids]) => <button key={gid} onClick={()=>open(ids[0])}><strong>{title}</strong><span>{ids.map(id=>sections.find(s=>s[0]===id)![1]).join(' · ')}</span><span aria-hidden="true"><ArrowRight size={18}/></span></button>)}</div>
  </>
}
