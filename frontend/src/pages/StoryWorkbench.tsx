import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { ModelsApi, StoryApi, withFileToken } from '../api'
import type { Model, StoryBeat, StoryCharacter, StoryGenerationRun, StoryPlanStep, StoryProject, StoryRecipe } from '../types'
import { applyStoryDraft, bibleText, editedBible } from '../lib/story-draft'
import StoryStart from '../components/story/StoryStart'
import StorySettings from '../components/story/StorySettings'
import StoryResults from '../components/story/StoryResults'
import StoryProducts from '../components/story/StoryProducts'
import StoryMaterials from '../components/story/StoryMaterials'
import StoryRecipes from '../components/story/StoryRecipes'
import StoryScript from '../components/story/StoryScript'
import StoryPlayground from '../components/story/StoryPlayground'
import StoryEpisodes from '../components/story/StoryEpisodes'
import StoryAdapt from '../components/story/StoryAdapt'
import StoryMethod from '../components/story/StoryMethod'
import StoryFilm from '../components/story/StoryFilm'
import StoryProjects from '../components/story/StoryProjects'
import StoryCraft from '../components/story/StoryCraft'
import StoryDialogue from '../components/story/StoryDialogue'
import StoryBatch from '../components/story/StoryBatch'
import StoryFlowBar from '../components/story/StoryFlowBar'
import { defaultRefStrategy, normalizeRefStrategy, refStrategyLabel, recipeBeatPatch } from '../lib/story-ref'
import type { StoryBeatInput } from '../types'
import '../components/story/story.css'

const emptyBeat: StoryBeat = { id: 'beat-1', kind: 'novel', prompt: '', references: [] }
const kindLabel = { novel: '段落', image: '画面', video: '视频' }
const modelKey = (m: Model) => `${m.provider}::${m.id}`
const modelValue = (key: string) => { const [provider, ...rest] = key.split('::'); return provider && rest.length ? { provider, id: rest.join('::') } : undefined }
const capable = (m: Model, kind: StoryBeat['kind']) => Boolean(m.capabilities?.[kind === 'novel' ? 'chat' : kind])

// 连续创作面板：已并入「创作」（pages/Workshop.tsx）作为一个页内视图，
// 因此不再自带 h1（由创作的 PageHeader 承担），也不再自带滚动容器（外层已滚）。
export function StoryPanel() {
  const [projects, setProjects] = useState<StoryProject[]>([])
  const [project, setProject] = useState<StoryProject | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [bibleDraft, setBibleDraft] = useState<Record<string,string>>({})
  const [assistResult, setAssistResult] = useState<any>(null)
  const [models, setModels] = useState<Model[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [planningModel, setPlanningModel] = useState('')
  const [selectedKind, setSelectedKind] = useState<StoryBeat['kind']>('novel')
  const [promptDraft, setPromptDraft] = useState('')
  // 台词（对白）与画面描述分开：台词是要留下来的剧作内容，画面描述是发给生成模型的指令。
  // 混在一起写，生图模型会试着把字画出来，而真正决定这段戏成不成立的对白反而没人看。
  const [dialogueDraft, setDialogueDraft] = useState('')
  const [inputDrafts, setInputDrafts] = useState<StoryBeatInput[]>([])
  // ComfyUI 那套产线纪律里最该补的三样：负向提示词、可复现的 seed、一次出多版。
  const [negativeDraft, setNegativeDraft] = useState('')
  const [seedDraft, setSeedDraft] = useState('')
  const [variantsDraft, setVariantsDraft] = useState('1')
  // 「这次到底会做什么」——预览与实跑共用同一个 plan，界面照它显示，而不是只给一段提示词
  const [plan, setPlan] = useState<StoryPlanStep[]>([])
  // 工艺参数（尺寸 / 时长）。以前 params 是个**没人填的空字段**——配方要携带它，就必须先有它。
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({})
  // 参考图策略：用几张、谁优先。以前这条策略硬编码在编排层里，用户在界面上既看不到也改不了。
  const [refDraft, setRefDraft] = useState<{ images: number; prefer: 'material' | 'portrait' }>({ images: 1, prefer: 'material' })
  // 剧本要素：动作与转场单独存（action 留空则导出时用画面描述兜底）。
  // 场景标题的三要素（内外景/地点/时间）存在场景上，不是段落上。
  const [actionDraft, setActionDraft] = useState('')
  // 镜头规格（景别/机位/运镜/光线/落幅/承接）：发往视频模型的"镜头语言"。
  // 以前只存在于提示词散文里，模型爱写不写；现在是可编辑字段，编译时放在提示词最前面。
  const [shotDraft, setShotDraft] = useState<{ size: string; angle: string; move: string; light: string; ending: string; carry: string }>({ size: '', angle: '', move: '', light: '', ending: '', carry: '' })
  const [transitionDraft, setTransitionDraft] = useState('')
  const [slugDraft, setSlugDraft] = useState<{ interior: string; location: string; timeOfDay: string }>({ interior: 'interior', location: '', timeOfDay: '' })
  const [compiled, setCompiled] = useState('')
  const [timelineOpen, setTimelineOpen] = useState(() => window.innerWidth > 640)
  const [storyboardIdea, setStoryboardIdea] = useState('')
  const [storyboardCount, setStoryboardCount] = useState('6')
  const [filmUrl, setFilmUrl] = useState('')
  const [lint, setLint] = useState<{ issues: { level: string; code: string; message: string }[]; summary: { characters: number; portraits: number; scenes: number; beats: number; level: string } } | null>(null)
  // selected 既可能是**段 id**（点某一段）也可能是**场 id**（分集面板里点某一场）。
  // 只按段 id 找的话，从分集面板点「第 3 场」会被静默落到第 1 场——看起来像跳转失灵。
  const scene = project?.scenes.find(s => s.id === selected || s.beats.some(b => b.id === selected)) || project?.scenes[0]
  const beat = scene?.beats.find(b => b.id === selected) || scene?.beats[0] || (scene ? emptyBeat : undefined)
  const availableModels = models.filter(m => capable(m, selectedKind))
  const selectedModelInfo = modelValue(selectedModel)
  const hydrateBible = (p: StoryProject) => setBibleDraft(bibleText(p.bible))
  const update = (p: StoryProject) => { setProject(p); setProjects(items => [p, ...items.filter(item => item.id !== p.id)]) }
  const choose = (p: StoryProject | null) => { setProject(p); setSelected(p?.scenes[0]?.beats[0]?.id || ''); if (p) hydrateBible(p); setAssistResult(null); setCompiled(''); setError(''); setNotice('') }
  useEffect(() => { if (beat) { setSelectedKind(beat.kind); setPromptDraft(beat.prompt); setDialogueDraft(beat.dialogue || ''); setInputDrafts(beat.inputs || []); setNegativeDraft(beat.negative || ''); setSeedDraft(''); setRefDraft(normalizeRefStrategy((beat as any).reference, beat.kind)); setActionDraft(beat.action || ''); setTransitionDraft(beat.transition || ''); const sh = (beat.shot || {}) as any; setShotDraft({ size: sh.size || '', angle: sh.angle || '', move: sh.move || '', light: sh.light || '', ending: sh.ending || '', carry: sh.carry || '' }) } setAssistResult(null); setCompiled('') }, [project?.id, beat?.id, beat?.kind, beat?.prompt, beat?.dialogue, beat?.inputs, beat?.negative, beat?.action, beat?.transition, (beat as any)?.shot])
  // 场景标题三要素跟着场景走
  useEffect(() => { const s = scene?.slug; setSlugDraft({ interior: s?.interior || 'interior', location: s?.location || '', timeOfDay: s?.timeOfDay || '' }) }, [project?.id, scene?.id, scene?.slug?.interior, scene?.slug?.location, scene?.slug?.timeOfDay])
  // 切换输出类型时，参考图策略的默认值跟着类型走（画面 1 张素材优先 / 视频 4 张定妆照优先）——
  // 否则从视频切到画面会沿用"4 张"，把一个只吃一张的通道撑爆。
  const setGenerationKind = (kind: StoryBeat['kind']) => { setSelectedKind(kind); setSelectedModel(''); setCompiled(''); setRefDraft(normalizeRefStrategy(undefined, kind)) }
  useEffect(() => { if (selectedModel && !availableModels.some(m => modelKey(m) === selectedModel)) setSelectedModel('') }, [selectedKind, models, selectedModel])
  const load = async () => {
    setBusy('正在加载故事'); setError('')
    try { const r = await StoryApi.listProjects(); setProjects(r.projects); choose(r.projects.find(p => p.id === project?.id) || r.projects[0] || null) }
    catch (e: any) { setError(e.message || '加载失败，请刷新重试') } finally { setBusy('') }
  }
  useEffect(() => { void load(); void ModelsApi.list().then(r => setModels(r.models || [])).catch(() => setError('模型列表加载失败，请刷新页面重试')) }, [])
  const action = async (label: string, fn: () => Promise<void>) => {
    if (busy) return
    setBusy(label); setError(''); setNotice('')
    try { await fn() } catch (e: any) { setError(e?.message || '操作未完成，请重试') } finally { setBusy('') }
  }
  const requestDraft = async (p: StoryProject, idea: string, kind: StoryBeat['kind']) => {
    const r = await StoryApi.assist(p.id, `目标输出：${kindLabel[kind]}。\n${idea}`, modelValue(planningModel))
    setAssistResult({ ...r.assist, beat: { ...r.assist.beat, kind } })
    setNotice('AI 草稿已准备好，查看后点击“采用并保存设定”。')
  }
  const start = (idea: string, kind: StoryBeat['kind']) => action('AI 正在整理人物与开场', async () => {
    const r = await StoryApi.createProject({ title: idea.slice(0, 24), logline: idea })
    const saved = await StoryApi.patchProject(r.project.id, { scenes: [{ id:'scene-1', index:1, title:'开场', summary:idea, beats:[{...emptyBeat,kind,prompt:idea}], outputs:[] }] })
    update(saved.project); hydrateBible(saved.project); setSelected('beat-1'); setSelectedKind(kind); setPromptDraft(idea)
    await requestDraft(saved.project, idea, kind)
  })
  const persist = async () => {
    if (!project) throw new Error('请先开始一个故事')
    const scenes = project.scenes.length ? project.scenes : [{id:'scene-1',index:1,title:'开场',summary:project.logline || '',beats:[],outputs:[]}]
    const target = scene || scenes[0]
    // 镜头规格只写填了的字段：空字符串会让"没写"和"写了空"变成两件事，编译时又多一个要判的分支；
    // 全清空时要**真的删掉**这个键，否则 {...beat} 会把旧规格带回来。
    const shotFields: Record<string, string> = {}
    for (const [k, v] of Object.entries(shotDraft)) if (String(v || '').trim()) shotFields[k] = String(v).trim()
    const nextBeat = { ...(beat || emptyBeat), kind:selectedKind, prompt:promptDraft.trim(), dialogue:dialogueDraft.trim(), inputs:inputDrafts, negative:negativeDraft.trim(), action:actionDraft.trim(), transition:transitionDraft.trim(), ...(Object.keys(shotFields).length ? { shot: shotFields } : {}) }
    if (!Object.keys(shotFields).length) delete (nextBeat as any).shot
    // 场景标题三要素存回场景上（空值不写，避免给项目塞一堆没用的字段）
    const slug = { ...(slugDraft.location.trim() ? { location: slugDraft.location.trim() } : {}), ...(slugDraft.timeOfDay.trim() ? { timeOfDay: slugDraft.timeOfDay.trim() } : {}), ...(slugDraft.interior !== 'interior' ? { interior: slugDraft.interior as 'interior' } : {}) }
    const r = await StoryApi.patchProject(project.id, { bible: editedBible(project.bible, bibleDraft), scenes: scenes.map(s => s.id !== target.id ? s : {...s, ...(Object.keys(slug).length ? { slug } : {}), beats:s.beats.some(b => b.id === nextBeat.id) ? s.beats.map(b => b.id === nextBeat.id ? nextBeat : b) : [...s.beats,nextBeat]}) })
    update(r.project); hydrateBible(r.project)
    return { project:r.project, sceneId:target.id, beatId:nextBeat.id }
  }
  const assist = () => action('AI 正在完善本段', async () => {
    const saved = await persist()
    await requestDraft(saved.project, `故事梗概：${saved.project.logline || ''}\n本段方向：${promptDraft}\n已有段落：${JSON.stringify(saved.project.scenes).slice(-10000)}\n只完善当前段落，保留已确定的人物设定。`, selectedKind)
  })
  const applyAssist = () => action('正在保存设定与本段草稿', async () => {
    if (!project || !scene || !beat || !assistResult) return
    const r = await StoryApi.patchProject(project.id, applyStoryDraft(project, assistResult, scene.id, beat.id))
    update(r.project); hydrateBible(r.project); setAssistResult(null); setNotice('人物、服装、风格和本段内容已一起保存，现在可以生成。')
  })
  // 这一次要带的参数：seed（留空=每版现掷并记下来）、变体数、负向提示词。
  // 以前这三样一个都没有——seed 界面上根本不存在，能力声明却写着支持。
  const runExtras = () => ({
    ...(seedDraft.trim() && Number.isFinite(Number(seedDraft.trim())) ? { seed: Number(seedDraft.trim()) } : {}),
    ...(Number(variantsDraft) > 1 ? { variants: Number(variantsDraft) } : {}),
    ...(negativeDraft.trim() ? { negative: negativeDraft.trim() } : {}),
    ...(Object.keys(paramDraft).length ? { params: paramDraft } : {}),
    reference: refDraft,
  })
  const IMAGE_SIZES = ['1024x1024', '832x1472', '1472x832']
  const VIDEO_SIZES = ['720P', '1080P']
  const VIDEO_SECONDS = ['5', '10']
  const setParam = (key: string, value: string) => setParamDraft(prev => {
    const next = { ...prev }
    if (value) next[key] = value; else delete next[key]
    return next
  })
  // 项目默认配方：段落没说的地方由它兜底（服务端在 buildRunPlan 里做同一件事）。
  // 前端拿它干两件事：显示"当前默认是谁"，以及给**新段落**盖上类型与负向。
  const { data: recipeData, mutate: mutateRecipes } = useSWR('story-recipes', () => StoryApi.recipes(), { revalidateOnFocus: false, dedupingInterval: 10000 })
  const patchProjectField = async (changes: Record<string, unknown>, note: string) => action(note, async () => {
    if (!project) return
    const r = await StoryApi.patchProject(project.id, changes as any)
    update(r.project)
    setNotice(note)
  })
  const setDefaultRecipe = (recipeId: string) => patchProjectField({ defaultRecipeId: recipeId || undefined }, recipeId ? '已设为项目默认配方，新段落会自动套用它的类型与负向' : '已取消项目默认配方')
  const currentDefaultRecipe: StoryRecipe | undefined = (recipeData?.recipes || []).find(r => r.id === project?.defaultRecipeId)
  const applyRecipe = (r: any, toAll: boolean) => action(toAll ? `正在把「${r.name}」套用到全部段落` : `正在套用配方「${r.name}」`, async () => {
    if (!project) return
    if (['novel', 'image', 'video'].includes(r.kind)) setSelectedKind(r.kind)
    if (r.model?.provider && r.model.provider !== 'auto') setSelectedModel(modelKey(r.model))
    setNegativeDraft(r.negative || '')
    setSeedDraft(r.seed != null ? String(r.seed) : '')
    setVariantsDraft(String(r.variants || 1))
    setParamDraft({ ...(r.params || {}) })
    setRefDraft(normalizeRefStrategy(r.reference, r.kind))
    setCompiled('')
    if (!toAll) { setNotice(`已套用配方「${r.name}」：${kindLabel[r.kind] || r.kind} / ${r.model?.provider || 'auto'}${r.negative ? ' / 带负向' : ''}${r.variants > 1 ? ` / ${r.variants} 版` : ''}`); return }
    // 套用到全项目只写**能存在段落上的**工艺（类型与负向）——模型/尺寸/seed 是每次生成时的选择
    const scenes = project.scenes.map(scene => ({
      ...scene,
      beats: (scene.beats || []).map(b => ({ ...b, ...(['novel', 'image', 'video'].includes(r.kind) ? { kind: r.kind } : {}), negative: r.negative || '' })),
    }))
    const res = await StoryApi.patchProject(project.id, { scenes })
    update(res.project)
    setNotice(`配方「${r.name}」已套用到本项目全部 ${scenes.reduce((n, s) => n + (s.beats?.length || 0), 0)} 段（类型与负向）`)
  })
  const run = () => action(`正在生成${kindLabel[selectedKind]}，请稍候`, async () => {
    const saved = await persist()
    try {
      const r = await StoryApi.run(saved.project.id, { sceneId:saved.sceneId, beatId:saved.beatId, kind: selectedKind, ...(selectedModelInfo ? {model:selectedModelInfo} : {}), ...runExtras() })
      update(r.project)
      setPlan(r.plan || [])
      const n = r.runs?.length || 1
      const pending = (r.runs || [r.run]).filter(x => x.status === 'running' && x.taskId)
      const failed = (r.runs || [r.run]).filter(x => x.status === 'failed')
      const degraded = (r.runs || [r.run]).filter(x => x.status === 'degraded')
      if (pending.length) {
        // 视频是异步的：创建成功只是"排上队了"，**不是"出片了"**。要说清区别并开始短轮询。
        setNotice(`已排上队（${pending.length} 个任务号），正在等上游出片——期间可以继续做别的事，也可以随时点「查一次」。`)
        void pollRuns(saved.project.id, saved.sceneId, pending, r.pollWindowMs || 600000)
      } else if (failed.length) setError(failed.map(x => x.degradation?.join('；')).join(' ／ ') || '生成失败，请更换模型重试')
      else if (degraded.length) setNotice(`${n > 1 ? `${n} 版已返回` : '本段结果已返回'}，但有降级项要看（见下方执行链的「注意」）。`)
      else setNotice(n > 1 ? `${n} 版已返回，都是同参换 seed 的变体，挑一版用。` : '本段结果已返回，请预览核对，再从此处继续。')
    } catch (e) {
      const latest = await StoryApi.getProject(saved.project.id).catch(() => null)
      if (latest) update(latest.project)
      throw e
    }
  })
  // 短轮询收尾：每 5 秒问一次上游状态，问到出片/真失败就停。
  // **超过 pollWindowMs 就停下、保留 running 与任务号**，让用户点「查一次」继续——
  // 「还没好」不是「失败」，这是以前 180s 硬超时最大的错。
  const pollRuns = async (projectId: string, sceneId: string, runs: StoryGenerationRun[], windowMs: number) => {
    const ids = new Set(runs.map(r => r.id))
    const deadline = Date.now() + windowMs
    while (ids.size && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000))
      for (const runId of [...ids]) {
        let res
        try { res = await StoryApi.checkRun(projectId, { sceneId, runId }) } catch { continue }
        if (res.project) update(res.project)
        if (res.settled) {
          ids.delete(runId)
          if (res.status === 'failed') setError(res.run?.degradation?.join('；') || '上游返回失败')
          else setNotice(res.status === 'degraded' ? '片子到了，但有降级项（见该版本上的说明）。' : '片子到了，已落盘。')
        }
      }
    }
    if (ids.size) setNotice(`等满 ${Math.round(windowMs / 60000)} 分钟还没出片——任务号还在，可以点该版本的「查一次」继续问。`)
  }
  // 手动查一次：给排队中的版本、也给"超窗后还想再问一句"的场景
  const checkOne = (runItem: StoryGenerationRun) => action('正在向上游问一次', async () => {
    if (!project || !scene) return
    const res = await StoryApi.checkRun(project.id, { sceneId: scene.id, runId: runItem.id })
    update(res.project)
    if (!res.settled) setNotice(`还在排队（上游状态：${res.upstream || 'pending'}）${res.waitedMs ? `，已等 ${Math.round(res.waitedMs / 60000)} 分钟` : ''}——不是失败，可以过会儿再点。`)
    else if (res.status === 'failed') setError(res.run?.degradation?.join('；') || '上游返回失败')
    else setNotice('片子到了，已落盘。')
  })
  const preview = () => action('正在检查生成输入', async () => {
    const saved = await persist()
    const r = await StoryApi.previewRun(saved.project.id, {sceneId:saved.sceneId,beatId:saved.beatId,kind:selectedKind,model:selectedModelInfo || {provider:'auto',id:'auto'}, ...runExtras()})
    setCompiled(r.context.prompt); setPlan(r.plan || []); setNotice('以下是「实际将执行」的完整链路与提示词；尚未调用生成模型。')
  })
  // 照这一版重跑：同模型 / 同 seed / 同负向 / 同参数。ComfyUI 里这是"再跑一次同样的图"，
  // 有了它，一次偶然的好结果才算真的可复现。
  const rerun = (prev: StoryGenerationRun) => action('正在照这一版重跑（同模型 · 同 seed）', async () => {
    if (!project || !scene || !beat) return
    const r = await StoryApi.run(project.id, {
      sceneId: scene.id, beatId: beat.id, kind: prev.kind,
      ...(prev.model?.id ? { model: prev.model } : {}),
      ...(Number.isFinite(prev.seed as number) ? { seed: Number(prev.seed) } : {}),
      ...(prev.negative ? { negative: prev.negative } : {}),
      ...(prev.params && Object.keys(prev.params).length ? { params: prev.params } : {}),
    })
    update(r.project); setPlan(r.plan || [])
    if (r.run?.status === 'failed') setError(r.run.degradation?.join('；') || '重跑失败')
    else setNotice(`已照第 ${(scene.outputs.filter(x => x.beatId === beat.id).length)} 版重跑（seed ${prev.seed ?? '未记录'}）。`)
  })
  const continueFromBeat = () => action('AI 正在构思下一段', async () => {
    const saved = await persist()
    const currentScene = saved.project.scenes.find(s => s.id === saved.sceneId)!
    const previous = currentScene.beats.find(b => b.id === saved.beatId)!
    // 新段落自动套用项目默认配方（类型与负向）——否则"默认配方"对新段落就是一句空话
    const next: StoryBeat = {id:`beat-${Date.now()}`,kind:selectedKind,prompt:'承接上一段的结尾，推进下一件具体事件，保持人物与设定一致，不重复开场。',references:previous.references || [],inheritFromBeatId:previous.id,...recipeBeatPatch(currentDefaultRecipe)}
    const r = await StoryApi.patchProject(saved.project.id, {scenes:saved.project.scenes.map(s => s.id !== currentScene.id ? s : {...s,beats:[...s.beats,next]})})
    update(r.project); setSelected(next.id)
    await requestDraft(r.project, `为下一段构思具体情节：${next.prompt}\n之前的段落和实际产出：${JSON.stringify(currentScene).slice(-10000)}`, selectedKind)
  })
  const saveBible = () => action('正在保存设定', async () => { if (project) { const r=await StoryApi.patchProject(project.id,{bible:editedBible(project.bible,bibleDraft)});update(r.project);hydrateBible(r.project);setNotice('设定已保存') } })
  // 角色定妆照：生成一张可复用的形象参考图并写回设定；
  // 之后生成画面/视频时编排层会自动把它作为真实参考图注入。
  const portrait = (character: StoryCharacter, lookName?: string) => action(`正在生成「${character.name || character.id}」${lookName ? `的「${lookName}」形象` : '的定妆照'}`, async () => {
    if (!project) return
    const r = await StoryApi.portrait(project.id, { characterId: character.id, ...(lookName ? { lookName } : {}) })
    update(r.project); hydrateBible(r.project)
    if (r.image) setNotice(`「${r.character?.name || character.name || character.id}」的定妆照已保存；后续画面与视频会带上它作为参考图。`)
    else setError(r.error || '定妆照生成失败，请换一个图像模型再试')
  })
  // 场景 / 道具参考图：和定妆照同一条通路，只是对象不同。
  // 之后这一段的提示词里出现该场景/道具的名字，它就会被当作真实参考图注入。
  const assetRef = (assetType: 'location' | 'prop', asset: { id: string; name?: string }) => action(`正在生成「${asset.name || asset.id}」的参考图`, async () => {
    if (!project) return
    const r = await StoryApi.assetRef(project.id, { assetType, assetId: asset.id })
    update(r.project); hydrateBible(r.project)
    const noun = assetType === 'location' ? '场景参考图' : '道具参考图'
    if (r.image) setNotice(`「${r.asset?.name || asset.name || asset.id}」的${noun}已保存；这一段的提示词里出现它的名字时就会带上它。`)
    else setError(r.error || `${noun}生成失败，请换一个图像模型再试`)
  })
  // 连续性体检：随项目/输出类型变化刷新；做完动作后再刷一次，让「缺定妆照/未继承」这类提示实时消失
  const refreshLint = async (id = project?.id, kind = selectedKind) => {
    if (!id) { setLint(null); return }
    try { setLint(await StoryApi.lint(id, { kind })) } catch { setLint(null) }
  }
  useEffect(() => { void refreshLint(project?.id, selectedKind) }, [project?.id, selectedKind])
  // 一键分镜：一次拿到整场分镜表，继承链由服务端串好，省掉一段一段点「从此处继续」
  const runStoryboard = () => action(`AI 正在排 ${storyboardCount} 段分镜`, async () => {
    if (!project) throw new Error('请先开始一个故事')
    const r = await StoryApi.storyboard(project.id, { idea: storyboardIdea.trim(), count: Number(storyboardCount) || 6 })
    update(r.project); hydrateBible(r.project)
    setStoryboardIdea('')
    const added = r.project.scenes.flatMap(scene => scene.beats).slice(-1)[0]
    if (added) setSelected(added.id)
    // 分镜同时把出场人物登记进设定：说清楚，否则用户不知道角色库是哪来的，
    // 也不知道「生成定妆照」现在有对象了。
    const cast = Array.isArray(r.characterNames) ? r.characterNames.filter(Boolean) : []
    setNotice(`已追加 ${r.beatCount} 段分镜（${r.sceneCount} 场），继承链已自动串好，可以逐段生成。${cast.length ? `同时登记了 ${cast.length} 个角色：${cast.slice(0, 4).join('、')}${cast.length > 4 ? ' 等' : ''}——现在可以给他们生成定妆照锁定长相。` : ''}`)
    await refreshLint(r.project.id)
  })
  // 成片合成：按分镜顺序把成功的视频片段拼成一条长片
  const makeFilm = () => action('正在合成成片（按分镜顺序拼接）', async () => {
    if (!project) throw new Error('请先开始一个故事')
    const r = await StoryApi.film(project.id)
    // 服务端已把这一版成片写回项目；这里用返回值刷新，刷新页面后链接也不会丢
    if (r.project) update(r.project)
    setFilmUrl(r.film?.url || r.url)
    setNotice(`成片已生成：${r.clipCount} 段拼接完成${r.method === 'copy' ? '（只有一段，直接落盘）' : ''}，已归档到工作空间并记入项目，共 ${(r.project?.films || project.films || []).length} 版。`)
  })
  // 删掉不要的那几版：同一段常常生成好几版镜头。
  // 删是不可逆的，所以结果必须说清"发生了什么"——记录删了没有、文件删了没有、为什么保留。
  const deleteRun = (target: StoryGenerationRun, opts: { keepFiles: boolean }) => action('正在删除这一版', async () => {
    if (!project || !scene) return
    try {
      const r = await StoryApi.deleteRun(project.id, { sceneId: scene.id, runId: target.id, ...(opts.keepFiles ? { keepFiles: true } : {}) })
      update(r.project)
      const kept = r.files.filter(f => !f.deleted && f.reason && !/你选了/.test(f.reason))
      setNotice(`已删除这一版（该段还剩 ${r.remaining} 版）。${r.fileDeleted ? `文件也删了 ${r.fileDeleted} 个。` : ''}${kept.length ? `保留文件：${kept.map(f => f.reason).join('；')}` : ''}${opts.keepFiles ? '文件按你的选择留着。' : ''}`)
    } catch (e: any) {
      // 409 = 还在排队的版本：给出"强制删除"这条路，而不是只说一句失败
      setError(`${e?.message || '删除失败'}`)
      throw e
    }
  })
  // 外链产物补下载：入库时下载失败留下的外站临时链接，会自己过期。
  // 这里只补下载、不重新生成——产物还在，只是没落到本地。
  const localizeRun = (target: StoryGenerationRun) => action('正在把这一版下载到本地', async () => {
    if (!project || !scene) return
    const r = await StoryApi.localizeRun(project.id, { sceneId: scene.id, runId: target.id })
    update(r.project)
    if (r.failed) setError(`有 ${r.failed} 个产物还是没能下载到本地：${r.results.filter(x => !x.ok).map(x => x.reason).join('；')}`)
    else setNotice(`这一版的 ${r.localized} 个产物已下载到本地，地址已换成工作区里的文件——外站链接失效也不影响了。`)
  })
  // 全项目补下载：参考图（定妆照/场景/道具）与每一次生成的产出都算"产物"，
  // 都可能还挂在外站临时链接上（入库时下载失败留下的）。只补下载、不重新生成。
  const localizeAll = () => action('正在把外站的产物拉到本地', async () => {
    if (!project) return
    const r = await StoryApi.localize(project.id, { scope: 'all' })
    update(r.project); hydrateBible(r.project)
    const failed = (r.items || []).filter((x: any) => !x.ok)
    if (r.localized === 0 && !failed.length) setNotice('没有需要下载的：项目里的产物都已经在本地了。')
    else if (failed.length) setError(`拉到本地：成功 ${r.localized} 个，失败 ${failed.length} 个 —— ${failed.map((x: any) => `${x.label || x.assetId || x.runId}：${x.reason}`).join('；')}`)
    else setNotice(`已把 ${r.localized} 个外站产物下载到本地并写回项目——外站链接失效也不影响了。（挂载素材不重复落盘：它引用的是别的工作台的产物。）`)
  })
  const currentRuns = scene?.outputs.filter(r => r.beatId === beat?.id) || []
  // 采用这一版：写回 beat.chosenRunId，合成成片时默认用它（filmPlan 会优先推荐它）。
  // 再点同一版就是**取消采用**——选择必须能撤销，否则手滑点错就永远改不回去。
  const adopt = (run: StoryGenerationRun) => action(run.id === beat?.chosenRunId ? '正在取消采用' : '正在采用这一版', async () => {
    if (!project || !scene || !beat) return
    const dropping = run.id === beat.chosenRunId
    const scenes = project.scenes.map(s => s.id !== scene.id ? s : {
      ...s,
      beats: s.beats.map(b => {
        if (b.id !== beat.id) return b
        const next: StoryBeat = { ...b }
        if (dropping) delete next.chosenRunId
        else next.chosenRunId = run.id
        return next
      }),
    })
    const r = await StoryApi.patchProject(project.id, { scenes })
    update(r.project)
    setNotice(dropping
      ? '已取消采用：合成成片时按最新的可用版本推荐。'
      : `已采用这一版${run.seed != null ? `（seed ${run.seed}）` : ''}：合成成片时默认用它，不用每段再挑一次。`)
  })
  // ── 状态条上的动作：复用已有处理器，做完**重新取一次项目** ──
  // patch/run 这些接口返回的项目里没有 flow（那是服务端算出来的），不重取就会一直显示旧状态，
  // 于是"刚做完还提示你做同一件事"——比没有状态条更让人困惑。
  const refreshFlow = async () => {
    if (!project) return
    try { const r = await StoryApi.getProject(project.id); update(r.project) } catch { /* 刷新失败不影响刚才那步 */ }
  }
  const flowAction = (target: string) => {
    const allRuns = (project?.scenes || []).flatMap(s => s.outputs || [])
    const cast = project?.bible.characters || []
    const firstNoPortrait = cast.find(c => !((c as any).refImage || (c as any).ref || (c as any).portrait))
    const locations = project?.bible.locations || []
    const props = project?.bible.props || []
    const firstNoRef = [...locations, ...props].find((a: any) => !(a.refImage || a.ref || a.anchor))
    const handlers: Record<string, () => void | Promise<void>> = {
      edit_outline: () => { setNotice('在右栏「人物与设定」里补梗概与人物，保存后这条状态会跟着变。') },
      generate_storyboard: () => runStoryboard(),
      next_beat: () => continueFromBeat(),
      generate_portrait: () => (firstNoPortrait ? portrait(firstNoPortrait) : setNotice('所有角色都有定妆照了')),
      generate_asset_ref: () => (firstNoRef
        ? assetRef(locations.includes(firstNoRef as any) ? 'location' : 'prop', firstNoRef as any)
        : setNotice('场景与道具的参考图都齐了')),
      generate_shot: () => run(),
      retry_failed: () => { const f = allRuns.find(r => r.status === 'failed'); return f ? rerun(f) : setNotice('没有失败的段落') },
      check_running: () => { const r = allRuns.find(x => x.status === 'running'); return r ? checkOne(r) : setNotice('没有进行中的任务') },
      localize_external: () => localizeAll(),
      compose_film: () => makeFilm(),
    }
    const fn = handlers[target]
    if (!fn) { setNotice(`这个动作还没接上：${target}`); return }
    void Promise.resolve(fn()).then(refreshFlow).catch(() => {})
  }
  const hasOutput = currentRuns.some(r => r.outputAssets?.length)
  // 成片链接来自**项目里存的成片历史**，不是一次性的本地状态——
  // 之前只 setFilmUrl，刷新页面链接就没了，用户以为合成失败了。
  const films = project?.films || []
  const latestFilm = films.length ? films[films.length - 1] : null
  const filmHref = latestFilm?.url || filmUrl
  const portraitCount = (project?.bible.characters || []).filter(c => c.refImage || (c as any).ref).length
  // 还挂在外站临时链接上的产物数量（参考图 + 每一次生成的产出）。>0 就在设定面板给一个补下载入口。
  const externalAssets = project ? [
    ...['characters', 'locations', 'props', 'wardrobe'].flatMap(k => (project.bible as any)[k] || []).map((x: any) => x.refImage),
    ...(project.scenes || []).flatMap(s => (s.outputs || []).flatMap(r => (r.outputAssets || []).map(a => a.url))),
  ].filter((u: any) => /^https?:/i.test(String(u || ''))).length : 0
  return <div className="story-workbench story-workbench-embedded">
    {/* 项目架取代原来的下拉框：项目一多，下拉里只看得到标题（哪个有成片、哪个是草稿、
        哪个是上周的，全看不出来），更不能删。这里每个项目一行，能看能删能打开。
        「新故事」也搬进来了，顶栏只留这一件事。 */}
    <StoryProjects
      projects={projects}
      currentId={project?.id}
      busy={Boolean(busy)}
      onOpen={choose}
      onNew={() => choose(null)}
      onRefresh={() => void load()}
      onDone={deletedId => {
        // 删完必须**把这一行从界面上拿掉**：真机点验时发现过只弹了"已删除"、列表里那行还在
        //（API 已经删了，界面没跟上——这类"说成功了但看到的不是那么回事"最容易让人不敢用）。
        // 这里直接按 id 从本地列表里剔除，而不是重新拉一遍：重新拉会走到 load() 的
        // "找不到当前项目就选第一个"分支，把用户顺手带到另一个项目上。
        setProjects(items => items.filter(item => item.id !== deletedId))
        if (project?.id === deletedId) choose(null)
      }}
      onNotice={setNotice}
      onError={setError}
    />
    <div aria-live="polite">{busy && <p role="status" className="story-notice">{busy}…</p>}{notice && <p role="status" className="story-notice">{notice}</p>}</div>
    {error && <p role="alert" className="story-notice story-error">{error}</p>}
    {!project ? <StoryStart busy={Boolean(busy)} onStart={start}><label className="story-model-select">构思模型<select value={planningModel} disabled={Boolean(busy)} onChange={e=>setPlanningModel(e.target.value)}><option value="">自动选择文本模型</option>{models.filter(m=>capable(m,'novel')).map(m=><option key={modelKey(m)} value={modelKey(m)}>{m.name || m.id}</option>)}</select></label></StoryStart> : <>
      {/* 状态条必须放在 .story-layout **外面**：那是个两列网格（时间线 | 编辑器），
          当成第一个 grid 子元素塞进去，它自己会占掉 200px 的时间线列，
          把时间线、编辑器、结果整列挤偏——真机上的"排版乱了"就是这么来的。 */}
      <StoryFlowBar flow={project.flow} busy={Boolean(busy)} onAction={flowAction} />
      <div className="story-layout">
      <details open={timelineOpen} onToggle={e=>setTimelineOpen(e.currentTarget.open)} className="story-timeline"><summary>分镜时间线 · {project.scenes.reduce((n,s)=>n+s.beats.length,0)} 段</summary><ol>{project.scenes.flatMap(s=>(s.beats.length?s.beats:[emptyBeat]).map(b=>({s,b}))).map(({s,b},i)=>{
        const latest=s.outputs?.filter(r=>r.beatId===b.id).slice(-1)[0]
        return <li key={b.id}><button disabled={Boolean(busy)} aria-current={beat?.id===b.id?'step':undefined} onClick={()=>setSelected(b.id)} title={b.prompt || b.dialogue || ''}><span>第 {i+1} 段 · {kindLabel[b.kind]}{b.dialogue?' · 有台词':''}{b.inputs?.length?` · 素材 ${b.inputs.length}`:''}</span>{/* 时间线只留一行：48 字塞进 200px 宽的列，一行只放得下 14 字，于是每段 3~4 行、
    7 段撑出 2216px 的一面文字墙（真机量过）。正文进 title，想细看就点开这一段去编辑区看。 */}
    <strong>{b.prompt?.slice(0,14) || b.dialogue?.split('\n')[0]?.slice(0,14) || '等待开场'}</strong><span>{latest?.status==='failed'?'生成失败':latest?.outputAssets?.length?'已有成品':latest?.status==='running'?'正在生成':'待生成'}{b.inheritFromBeatId?' · 承接前文':''}</span></button></li>
      })}</ol></details>
      <main className="story-main">
        <div className="story-steps"><span className="is-ready">1 想法已建立</span><span className={project.bible.characters?.length?'is-ready':''}>2 确定人物与设定</span><span className={hasOutput?'is-ready':''}>3 生成并预览</span></div>
        <section className="story-studio" aria-label="制作台">
          <div className="story-studio-row">
            <label className="story-studio-count">段数<select aria-label="分镜段数" value={storyboardCount} disabled={Boolean(busy)} onChange={e=>setStoryboardCount(e.target.value)}>{['4','6','8','10','12'].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
            <input className="story-studio-idea" aria-label="分镜想法" placeholder="想讲什么（可留空，按梗概排）" value={storyboardIdea} disabled={Boolean(busy)} onChange={e=>setStoryboardIdea(e.target.value)} />
            <button className="btn-ghost" disabled={Boolean(busy)} onClick={runStoryboard}>一键分镜</button>
            <button className="btn-primary" disabled={Boolean(busy)} onClick={makeFilm}>合成成片</button>
            {filmHref && <a className="story-studio-link" href={withFileToken(filmHref)} target="_blank" rel="noreferrer">打开成片{films.length > 1 ? `（第 ${films.length} 版）` : ''}</a>}
          </div>
          {lint && <div className={`story-lint story-lint-${lint.summary.level}`}>
            <span className="story-lint-head">连续性体检 · 角色 {lint.summary.characters}（定妆照 {lint.summary.portraits}）· {lint.summary.scenes} 场 {lint.summary.beats} 段</span>
            {lint.issues.length === 0
              ? <span className="story-lint-ok">条件齐备，可以开始生成。</span>
              : <>
                {/* 默认只摆前 2 条：一串红字会把整块染红、也把"要先改哪一条"淹掉。
                    其余折进 details——数量写在 summary 上，不藏信息，只是不抢注意力。 */}
                <ul>{lint.issues.slice(0, 2).map(i=><li key={`${i.code}-${i.message}`} className={`story-lint-item story-lint-item-${i.level}`}>{i.message}</li>)}</ul>
                {lint.issues.length > 2 && <details className="story-lint-more">
                  <summary>还有 {lint.issues.length - 2} 条</summary>
                  <ul>{lint.issues.slice(2, 12).map(i=><li key={`${i.code}-${i.message}`} className={`story-lint-item story-lint-item-${i.level}`}>{i.message}</li>)}</ul>
                </details>}
              </>}
          </div>}
        </section>
        <div className="story-editor-layout"><section className="story-editor">
          <div className="story-section-head"><h2>{scene?.title || '故事开场'}</h2><span>{beat?.inheritFromBeatId?'承接前文':'故事起点'}</span></div>
          <div className="story-form-row"><label>输出类型<select aria-label="选择输出类型" disabled={Boolean(busy)} value={selectedKind} onChange={e=>setGenerationKind(e.target.value as StoryBeat['kind'])}><option value="novel">小说段落</option><option value="image">故事画面</option><option value="video">视频片段</option></select></label><label>生成模型<select aria-label="选择模型" disabled={Boolean(busy)} value={selectedModel} onChange={e=>setSelectedModel(e.target.value)}><option value="">自动选择模型</option>{availableModels.map(m=><option key={modelKey(m)} value={modelKey(m)}>{m.name || m.id}</option>)}</select></label></div>
          <label>本段内容<textarea aria-label="本段内容" disabled={Boolean(busy)} value={promptDraft} onChange={e=>{setPromptDraft(e.target.value);setCompiled('')}} rows={6} placeholder="写下本段想发生的事，或让 AI 帮你完善" /></label>
          <label>本段台词 · 对白<textarea aria-label="本段台词" disabled={Boolean(busy)} value={dialogueDraft} onChange={e=>{setDialogueDraft(e.target.value);setCompiled('')}} rows={4} placeholder={'一行一句，写成「角色名：台词」。这是故事的骨头——人物说了什么，比镜头怎么推更重要。'} /></label>
          <div className="story-form-row">
            <label>本段动作 · 剧本动作行<input aria-label="本段动作" disabled={Boolean(busy)} value={actionDraft} onChange={e=>{setActionDraft(e.target.value);setCompiled('')}} placeholder="留空则导出时用「本段内容」（画面描述）兜底" /></label>
            <label>转场<input aria-label="转场" disabled={Boolean(busy)} value={transitionDraft} onChange={e=>setTransitionDraft(e.target.value)} placeholder="例如 切至 / CUT TO:" /></label>
          </div>
          <div className="story-form-row">
            <label>内外景<select aria-label="内外景" disabled={Boolean(busy)} value={slugDraft.interior} onChange={e=>setSlugDraft({...slugDraft, interior:e.target.value})}><option value="interior">内景</option><option value="exterior">外景</option><option value="mixed">内外景</option></select></label>
            <label>地点<input aria-label="场景地点" disabled={Boolean(busy)} value={slugDraft.location} onChange={e=>setSlugDraft({...slugDraft, location:e.target.value})} placeholder="留空用场景名" /></label>
            <label>时间<input aria-label="场景时间" disabled={Boolean(busy)} value={slugDraft.timeOfDay} onChange={e=>setSlugDraft({...slugDraft, timeOfDay:e.target.value})} placeholder="例如 夜 / 清晨" /></label>
          </div>
          <StoryMaterials materials={inputDrafts} busy={Boolean(busy)} onChange={next => { setInputDrafts(next); setCompiled('') }} />
          <label>本段负向提示词 · 不要出现什么<textarea aria-label="本段负向提示词" disabled={Boolean(busy)} value={negativeDraft} onChange={e=>{setNegativeDraft(e.target.value);setCompiled('')}} rows={2} placeholder="一行一条，例如：多余的手指、文字水印、现代服装" /></label>
          <div className="story-form-row">
            <label>seed（留空=每版现掷并记下来）<input aria-label="seed" disabled={Boolean(busy)} value={seedDraft} onChange={e=>setSeedDraft(e.target.value.replace(/[^0-9]/g,''))} placeholder="填数字即锁定，可复现" /></label>
            <label>一次出几版<select aria-label="变体数量" value={variantsDraft} disabled={Boolean(busy)} onChange={e=>setVariantsDraft(e.target.value)}>{['1','2','3','4'].map(n=><option key={n} value={n}>{n} 版</option>)}</select></label>
            {selectedKind === 'image' && <label>尺寸<select aria-label="尺寸" disabled={Boolean(busy)} value={paramDraft.size || ''} onChange={e=>setParam('size', e.target.value)}><option value="">默认</option>{IMAGE_SIZES.map(sz=><option key={sz} value={sz}>{sz}</option>)}</select></label>}
            {selectedKind === 'video' && <label>尺寸<select aria-label="尺寸" disabled={Boolean(busy)} value={paramDraft.size || ''} onChange={e=>setParam('size', e.target.value)}><option value="">默认</option>{VIDEO_SIZES.map(sz=><option key={sz} value={sz}>{sz}</option>)}</select></label>}
            {selectedKind === 'video' && <label>时长<select aria-label="时长" disabled={Boolean(busy)} value={paramDraft.seconds || ''} onChange={e=>setParam('seconds', e.target.value)}><option value="">默认</option>{VIDEO_SECONDS.map(s=><option key={s} value={s}>{s} 秒</option>)}</select></label>}
          </div>
          {selectedKind !== 'novel' && <div className="story-form-row">
            <label>参考图张数<select aria-label="参考图张数" disabled={Boolean(busy)} value={String(refDraft.images)} onChange={e=>setRefDraft({ ...refDraft, images: Number(e.target.value) })}>{['0','1','2','3','4'].map(n=><option key={n} value={n}>{n === '0' ? '不用' : `${n} 张`}</option>)}</select></label>
            <label>谁优先<select aria-label="参考图优先" disabled={Boolean(busy) || refDraft.images === 0} value={refDraft.prefer} onChange={e=>setRefDraft({ ...refDraft, prefer: e.target.value as 'material' | 'portrait' })}><option value="material">挂载素材优先</option><option value="portrait">定妆照优先</option></select></label>
            <span className="story-hint">当前：{refStrategyLabel(selectedKind, refDraft)}</span>
          </div>}
          <StoryRecipes
            current={{ kind: selectedKind, model: selectedModelInfo || { provider: 'auto', id: 'auto' }, params: paramDraft, negative: negativeDraft.trim(), reference: refDraft, seed: seedDraft.trim() ? Number(seedDraft.trim()) : null, variants: Number(variantsDraft) || 1 }}
            busy={Boolean(busy)}
            onApply={r => applyRecipe(r, false)}
            onApplyToProject={r => applyRecipe(r, true)}
            defaultRecipeId={project?.defaultRecipeId || ''}
            onSetDefault={setDefaultRecipe}
            onChanged={() => void mutateRecipes()}
            onPatchProject={() => void load()}
          />
          <StoryScript project={project} busy={Boolean(busy)} onPatchProject={() => void load()} />
          <StoryEpisodes project={project} busy={Boolean(busy)} onDone={update} onPickScene={setSelected} />
          <StoryMethod project={project} busy={Boolean(busy)} onDone={update} />
          <StoryCraft project={project} busy={Boolean(busy)} onDone={update} onNotice={setNotice} onError={setError} />
          <StoryDialogue project={project} sceneId={scene?.id} busy={Boolean(busy)} onDone={update} onNotice={setNotice} onError={setError} />
          <StoryFilm project={project} busy={Boolean(busy)} onDone={update} onNotice={setNotice} onError={setError} />
          <StoryAdapt project={project} busy={Boolean(busy)} onDone={update} />
          <StoryBatch project={project} selectedSceneId={scene?.id} busy={Boolean(busy)} onDone={update} />
          {scene && beat && <StoryPlayground
            project={project}
            sceneId={scene.id}
            beatId={beat.id}
            characters={project.bible.characters || []}
            turns={beat.playground || []}
            busy={Boolean(busy)}
            onDone={update}
          />}
          <div className="story-form-row"><label>构思模型<select value={planningModel} disabled={Boolean(busy)} onChange={e=>setPlanningModel(e.target.value)}><option value="">自动选择文本模型</option>{models.filter(m=>capable(m,'novel')).map(m=><option key={modelKey(m)} value={modelKey(m)}>{m.name || m.id}</option>)}</select></label><div className="story-actions"><button className="btn-ghost" disabled={Boolean(busy)} onClick={assist}>让 AI 完善本段</button></div></div>
          {assistResult && <div className="story-draft"><h3>AI 草稿 · 确认后一起保存</h3><p>{assistResult.scene?.summary}</p><p>{assistResult.beat?.prompt}</p><p className="story-hint">人物：{assistResult.characters?.map((c:any)=>[c.name,c.appearance].filter(Boolean).join(' · ')).join('；') || '沿用既有设定'}</p><div className="story-actions"><button className="btn-primary" disabled={Boolean(busy)} onClick={applyAssist}>采用并保存设定</button><button className="btn-ghost" disabled={Boolean(busy)} onClick={()=>setAssistResult(null)}>暂不采用</button></div></div>}
          <p className="story-hint">{selectedKind==='novel'?'续写会带上已保存的设定和继承段落的实际正文。':`已生成的定妆照会作为真实参考图注入（画面走图生图、视频走 reference），用来锁住人物外貌；还没有定妆照的角色只能靠文字描述。当前 ${portraitCount}/${(project.bible.characters||[]).length} 个角色有定妆照。`}{selectedKind==='video'?' 每次生成一个视频片段，攒够成功的片段后用左侧「合成成片」拼成长片。':''}</p>
          {/* 镜头规格：这六格是**发往视频模型的镜头语言**，编译时排在提示词最前面。
              以前它们只存在于提示词散文里（模型爱写不写），于是出片"像 AI 图动了一下"——
              同一句话创意，人家写全了景别/机位/光线/落幅才像电影。落幅尤其别省。 */}
          {selectedKind !== 'novel' && <div className="story-form-row story-shot-spec">
            <label>景别<select aria-label="景别" disabled={Boolean(busy)} value={shotDraft.size} onChange={e=>{setShotDraft({...shotDraft, size:e.target.value});setCompiled('')}}><option value="">不指定</option>{['大远景','远景','全景','中全景','中景','中近景','近景','特写','大特写'].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
            <label>机位<select aria-label="机位" disabled={Boolean(busy)} value={shotDraft.angle} onChange={e=>{setShotDraft({...shotDraft, angle:e.target.value});setCompiled('')}}><option value="">不指定</option>{['平视','俯拍','仰拍','斜角','过肩','主观'].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
            <label>运镜<select aria-label="运镜" disabled={Boolean(busy)} value={shotDraft.move} onChange={e=>{setShotDraft({...shotDraft, move:e.target.value});setCompiled('')}}><option value="">不指定</option>{['固定','缓缓推近','拉远','横移','跟拍','摇镜','升降','环绕','手持'].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
            <label>光线<input aria-label="光线" disabled={Boolean(busy)} value={shotDraft.light} onChange={e=>{setShotDraft({...shotDraft, light:e.target.value});setCompiled('')}} placeholder="例如 窗外折射的柔和自然光" /></label>
          </div>}
          {selectedKind !== 'novel' && <div className="story-form-row story-shot-spec">
            <label>落幅<textarea aria-label="落幅" disabled={Boolean(busy)} rows={2} value={shotDraft.ending} onChange={e=>{setShotDraft({...shotDraft, ending:e.target.value});setCompiled('')}} placeholder="这一镜最后定格在哪，例如 落幅定格在她落寞无助的侧脸（不写，剪起来就是跳的）" /></label>
            <label>承接<textarea aria-label="承接" disabled={Boolean(busy)} rows={2} value={shotDraft.carry} onChange={e=>{setShotDraft({...shotDraft, carry:e.target.value});setCompiled('')}} placeholder="从上一镜的哪个落点接起，例如 承接上一镜她关上冰柜门的落点" /></label>
          </div>}
          <p className="story-hint">镜头规格会编译成提示词最前面那几句（景别+机位 → 光线/色调/质感 → 画面 → 运镜 → 落幅 → 承接）。留空不编造；点「检查生成输入」能看到编译后的全文。</p>
          <div className="story-actions"><button className="btn-primary" disabled={Boolean(busy)||!promptDraft.trim()} onClick={run}>生成当前{kindLabel[selectedKind]}</button><button className="btn-ghost" disabled={Boolean(busy)||!promptDraft.trim()} onClick={preview}>检查生成输入</button><button className="btn-ghost" disabled={Boolean(busy)||!hasOutput} onClick={continueFromBeat}>从此处继续 · AI 构思下一段</button></div>
          {!hasOutput && <p className="story-hint">先生成本段成品，再继续下一段。结果不满意时可以修改内容重新生成，旧版本会保留。</p>}
          {compiled && <details open><summary>本次生成输入</summary>
            {plan.length > 0 && <div className="story-plan">
              <p className="story-hint">这条链路就是接下来真正会执行的东西（预览与实跑共用同一份计算，不是另算一遍给你看的）。</p>
              <dl>{plan.map(step => <div key={step.label} className="story-plan-row"><dt>{step.label}</dt><dd>{step.detail}</dd></div>)}</dl>
            </div>}
            <details><summary>编译后的提示词全文</summary><div className="story-prose">{compiled}</div></details>
          </details>}
        </section>{scene && beat && <StoryResults scene={scene} beat={beat} busy={Boolean(busy)} onRerun={rerun} onCheck={checkOne} onDelete={deleteRun} onLocalize={localizeRun} onAdopt={adopt} canAdopt={selectedKind === 'video'} />}</div>
        <StorySettings values={bibleDraft} busy={Boolean(busy)} characters={project.bible.characters || []} locations={(project.bible.locations || []) as any} props={(project.bible.props || []) as any} externalAssets={externalAssets} onPortrait={portrait} onAssetRef={assetRef} onLocalizeAll={localizeAll} onChange={setBibleDraft} onSave={saveBible} />
        <StoryProducts project={project} onPick={setSelected} />
      </main>
    </div></>}
  </div>
}

export default StoryPanel
