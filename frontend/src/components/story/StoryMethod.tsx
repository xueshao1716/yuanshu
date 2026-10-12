import ThemedSelect from '../../components/ThemedSelect'
import { useState } from 'react'
import useSWR from 'swr'
import { StoryApi } from '../../api'
import type { StoryMethod, StoryProject } from '../../types'

// 创作方法包（Skill：程序性知识）——照 Lovart 的做法补的一层。
//
// Lovart 最值得抄的一条不是"它接了多少模型"，而是它把**方法**做成了可复用的资产：
// 一个 Skill 封装的不是视觉效果，而是"完成一个创作任务的整套方法"——任务怎么拆、
// 按什么顺序执行、遵循什么专业标准、修改时从哪一步入手、交付物要满足什么要求；
// 而且**用户自己跑通的一次过程能一键存成个人 Skill**，下次做同类内容直接调用同一套方法。
// 他们的原话是"垂直 Agent 的竞争，正从'谁接了最强的模型'走向'谁积累了最多专业工作方法'"。
//
// 元枢此前的"配方"只存工艺参数（类型/模型/尺寸/负向/seed/参考图策略）。
// "一集 90 秒、每集 6 场、前 3 秒出冲突、每集结尾留钩子"这些是方法，不是参数，
// 此前没有任何落点——每次都要在提示词里重新交代，于是第一集和第五集往往不是一个打法。
//
// 边界（写在这里免得日后被"顺手"改掉）：
// - 方法包**只给建议与约束**，不接管工艺参数；
// - 套用它只写结构性字段（没排过时长的集），**不覆盖**用户自己排的时长与人工调好的画风；
// - 内置方法包不可改不可删：改它等于改所有项目的标准，而且升级会被覆盖。
const sourceLabel: Record<string, string> = { builtin: '预置', project: '从项目存的', user: '我存的' }
const itemText = (v: string | { title?: string; detail?: string; text?: string }) =>
  typeof v === 'string' ? v : [v.title, v.detail || v.text].filter(Boolean).join('：')

export default function StoryMethod({ project, busy, onDone }: {
  project: StoryProject
  busy: boolean
  onDone: (project: StoryProject) => void
}) {
  const { data, mutate } = useSWR('story-methods', () => StoryApi.methods(), { revalidateOnFocus: false })
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState('')
  const [saveName, setSaveName] = useState('')
  const [msg, setMsg] = useState('')
  const methods: StoryMethod[] = data?.methods || []
  const current = methods.find(m => m.id === project.methodId)
  const shown = methods.find(m => m.id === pick) || current

  const act = async (fn: () => Promise<string>) => {
    setMsg('')
    try { const m = await fn(); await mutate(); setMsg(m) } catch (e: any) { setMsg(e?.message || '没成功') }
  }
  const apply = (methodId: string) => act(async () => {
    const r = await StoryApi.applyMethod(project.id, { methodId })
    onDone(r.project)
    if (!methodId) return '已解除方法包，之后的生成按普通流程走。'
    const bits = [r.applied.episodes ? `给 ${r.applied.episodes} 个还没排时长的集写上目标时长 ${r.method?.targetSeconds} 秒` : '集时长保持你排过的，不动']
    if (r.applied.style) bits.push('画风为空，写入了方法包的画风建议')
    return `已套用「${r.method?.name}」：${bits.join('；')}。一键分镜与原著改编会照这套方法走。`
  })
  const capture = () => act(async () => {
    const r = await StoryApi.captureMethod(project.id, { name: saveName.trim() || `${project.title} 的打法` })
    setSaveName(''); setPick(r.method.id)
    return `已把「${r.capturedFrom.title}」跑通的打法存成方法包「${r.method.name}」，别的项目也能直接用。`
  })
  const cloneBuiltin = (m: StoryMethod) => act(async () => {
    const r = await StoryApi.saveMethod({ ...m, id: undefined, name: `${m.name}（我的）`, source: 'user' })
    setPick(r.method.id)
    return `已复制成「${r.method.name}」，现在可以改它。`
  })
  const remove = (m: StoryMethod) => act(async () => {
    const r = await StoryApi.deleteMethod(m.id)
    if (project.methodId === m.id) onDone((await StoryApi.applyMethod(project.id, { methodId: '' })).project)
    return r.ok ? `已删掉「${m.name}」` : '这条不在可删范围里'
  })

  return <div className="story-method">
    <div className="story-head">
      <span>创作方法包{current ? ` · ${current.name}` : ' · 未选'}</span>
      <button className="btn-ghost" disabled={busy} onClick={() => setOpen(o => !o)}>{open ? '收起' : '方法包'}</button>
    </div>
    {open && <div className="story-method-body">
      <p className="story-hint">
        方法包管<strong>怎么拍</strong>（一集多长、每集几场、前几秒要出什么、什么时候算做完），
        配方管<strong>怎么生成</strong>（类型、模型、尺寸、负向、seed、参考图）。两者刻意分开：换画风不必换方法，换方法也不必重调参数。
        套用后一键分镜与原著改编会照这套方法走。
      </p>
      <div className="story-method-pick">
        <ThemedSelect aria-label="选择方法包" disabled={busy} value={pick || project.methodId || ''} onChange={e => setPick(e.target.value)}>
          <option value="">看一个方法包…</option>
          {methods.map(m => <option key={m.id} value={m.id}>{m.name}（{sourceLabel[m.source] || m.source}）</option>)}
        </ThemedSelect>
        <button className="btn-primary" disabled={busy || !pick} onClick={() => apply(pick)}>套用到本项目</button>
        {project.methodId && <button className="btn-ghost" disabled={busy} onClick={() => apply('')}>解除</button>}
      </div>
      {shown && <div className="story-method-card">
        <div className="story-method-title">
          <strong>{shown.name}</strong>
          <span>{sourceLabel[shown.source] || shown.source}</span>
          <span>{shown.reasoning === 'thinking' ? '深思档（先规划再执行）' : '快档（轻量单轮）'}</span>
          <span>单集 {shown.targetSeconds} 秒 · 每集约 {shown.scenesPerEpisode} 场 · 每场约 {shown.beatsPerScene} 段</span>
        </div>
        {shown.goal && <p className="story-method-goal">{shown.goal}</p>}
        {shown.steps.length > 0 && <ol className="story-method-steps">
          {shown.steps.map((s, i) => <li key={i}><strong>{s.title || `第 ${i + 1} 步`}</strong>{s.detail ? `：${s.detail}` : ''}</li>)}
        </ol>}
        {shown.rules.length > 0 && <div className="story-method-block"><span>必须遵守</span>
          <ul>{shown.rules.map((r, i) => <li key={i}>{itemText(r)}</li>)}</ul></div>}
        {shown.checklist.length > 0 && <div className="story-method-block"><span>交付前过一遍</span>
          <ul>{shown.checklist.map((c, i) => <li key={i}>{itemText(c)}</li>)}</ul></div>}
        {shown.deliverables.length > 0 && <div className="story-method-block"><span>该拿出的东西</span>
          <ul>{shown.deliverables.map((d, i) => <li key={i}>{itemText(d)}</li>)}</ul></div>}
        <div className="story-actions">
          {project.methodId !== shown.id && <button className="btn-ghost" disabled={busy} onClick={() => apply(shown.id)}>套用到本项目</button>}
          {shown.source === 'builtin'
            ? <button className="btn-ghost" disabled={busy} onClick={() => cloneBuiltin(shown)}>复制成我的（内置不可改）</button>
            : <button className="btn-ghost" disabled={busy} onClick={() => remove(shown)}>删除</button>}
        </div>
      </div>}
      <div className="story-method-save">
        <input aria-label="方法包名字" value={saveName} disabled={busy} placeholder={`把「${project.title}」跑通的打法存成方法包（留空自动命名）`} onChange={e => setSaveName(e.target.value)} />
        <button className="btn-ghost" disabled={busy} onClick={capture}>从当前项目存成方法包</button>
      </div>
      <p className="story-hint">存下来的是<strong>结构与配比</strong>（几集、每集几场、每场几段、目标时长、用了哪些类型），不会把你这个项目的提示词和台词抄进去——抄了内容就不能跨项目用了。</p>
      {msg && <p role="status" className="story-notice">{msg}</p>}
    </div>}
  </div>
}
