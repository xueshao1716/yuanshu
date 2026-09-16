import { useState } from 'react'
import { ImagePlus, Presentation, BookOpen, Smartphone, Film, Clapperboard } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import GeneratePanel from '../components/GeneratePanel'
import VideoGeneratePanel from '../components/VideoGeneratePanel'
import VideoPrompt from '../components/VideoPrompt'
import WorkshopView from '../components/WorkshopView'
import NovelStudioView from '../components/NovelStudioView'
import WanXiang from '../components/WanXiang'
import WorkshopUiBoard from '../components/WorkshopUiBoard'
import { StoryPanel } from './StoryWorkbench'

// ── 专项工作台：出图 / 视频 / PPT / 小说 / 界面工坊 / 连续创作 ──

type Tab = 'image' | 'video' | 'ppt' | 'novel' | 'ui' | 'story'
const TABS: [Tab, typeof ImagePlus | typeof Film, string][] = [
  ['image', ImagePlus, 'AI 绘画'],
  ['video', Film, '视频工坊'],
  ['ppt', Presentation, 'PPT 生成'],
  ['novel', BookOpen, '小说工坊'],
  ['story', Clapperboard, '连续创作'],
  ['ui', Smartphone, '界面工坊'],
]
const TAB_DESC: Record<Tab, string> = {
  image: '万像写提示词，选模型出图，成品自动归档到资产库',
  video: '技能写镜头提示词，选模型出片，成品自动归档到生成物/视频',
  ppt: '走 ppt-generator 技能全流程，通常需要几分钟',
  novel: '项目管理：产品化 → 五层 → 真相 → 写章 → 修订 → 导出',
  story: '先完成一段好故事，再让人物和情节接着走；分镜、设定与成品都在同一处',
  ui: 'M3E 拖拽草图板：拼组件 → 调主题 → 导出 Prompt 给 AI 编码',
}

export default function Workshop({ initialTab }: { initialTab?: Tab } = {}) {
  const [imagePrompt, setImagePrompt] = useState('')
  const [videoPrompt, setVideoPrompt] = useState('')
  const [videoSeconds, setVideoSeconds] = useState('10')
  const [videoFrame, setVideoFrame] = useState('16:9')
  const [tab, setTab] = useState<Tab>(() => {
    if (initialTab) return initialTab
    try {
      const saved = localStorage.getItem('pi_workshop_tab')
      if (saved === 'wanxiang') return 'image'
      return TABS.some(([key]) => key === saved) ? saved as Tab : 'image'
    } catch { return 'image' }
  })

  const chooseTab = (next: Tab) => {
    setTab(next)
    try { localStorage.setItem('pi_workshop_tab', next) } catch {}
    if (next === 'ui') {
      try { sessionStorage.setItem('yuanshu-open-ui', '1') } catch {}
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto page-enter">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
        <PageHeader title="创作" description={TAB_DESC[tab]} />

        <div data-slot="workshop-tabs" className="grid grid-cols-2 w-full sm:inline-flex sm:w-auto gap-1 mb-5 p-1 rounded-pi-lg bg-pi-bg2/60 border border-pi-border-soft">
          {TABS.map(([k, Icon, label]) => (
            <button key={k} onClick={() => chooseTab(k)}
              className={`flex items-center justify-center gap-1.5 min-h-11 px-2 sm:px-3.5 text-xs rounded-pi-md transition-colors duration-fast ${
                tab === k ? 'bg-pi-accent text-pi-on-accent font-medium' : 'text-pi-dim hover:text-pi-text'}`}>
              <Icon className="w-3.5 h-3.5" strokeWidth={1.8} />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>

        {tab === 'image' && (
          <div className="max-w-3xl space-y-4">
            <GeneratePanel onGenerated={() => {}} prompt={imagePrompt} onPromptChange={setImagePrompt} />
            <div className="panel !p-3">
              <div className="text-sm font-semibold text-pi-text">万像人物 · 构图骨架写提示词</div>
              <p className="text-[11px] text-pi-dim2 mt-1.5 mb-3">生成后会填入上方出图框，也可手动点「填入出图框」。</p>
              <WanXiang onUsePrompt={setImagePrompt} />
            </div>
          </div>
        )}
        {tab === 'video' && (
          <div className="max-w-3xl space-y-4">
            <VideoGeneratePanel
              onGenerated={() => {}}
              prompt={videoPrompt}
              onPromptChange={setVideoPrompt}
              seconds={videoSeconds}
              onSecondsChange={setVideoSeconds}
              frame={videoFrame}
              onFrameChange={setVideoFrame}
            />
            <div className="panel !p-3">
              <div className="text-sm font-semibold text-pi-text">镜头提示词 · shortform / Seedance</div>
              <p className="text-[11px] text-pi-dim2 mt-1.5 mb-3">生成后会填入上方出片框，也可手动点「填入出片框」。</p>
              <VideoPrompt
                onUsePrompt={setVideoPrompt}
                onSpecChange={({ seconds, frame }) => { setVideoSeconds(seconds); setVideoFrame(frame) }}
              />
            </div>
          </div>
        )}
        {tab === 'ppt' && <WorkshopView key="ppt" kind="ppt" />}
        {tab === 'novel' && <NovelStudioView />}
        {tab === 'story' && <StoryPanel />}
        {tab === 'ui' && <WorkshopUiBoard />}
      </div>
    </div>
  )
}
