import ThemedSelect from '../components/ThemedSelect'
import { useMemo, useState } from 'react'
import { Plus, Trash2, RefreshCw, Loader2 } from 'lucide-react'
import { WorkshopApi } from '../api'

// ── PPT 大纲预览 / 设计干预（2026-09-03）：结构化页面卡，改完本地秒级重建 .pptx ──
// 数据源是 ppt-generator 管线的中间产物（slides JSON），与 generate_pptx.py 白名单对齐。

export interface OutlineSlide { layout: string; title: string; content: string[] }

const LAYOUT_OPTIONS: [string, string][] = [
  ['TitleSlide', '封面页'], ['SectionHeader', '章节页'], ['TitleAndContent', '标题+内容'],
  ['TwoColumnText', '双栏文本'], ['ContentWithCaption', '图文说明'], ['BulletList', '要点列表'], ['BlankSlide', '空白页'],
]
const layoutLabel = (k: string) => LAYOUT_OPTIONS.find(o => o[0] === k)?.[1] || k

export default function PptOutlineEditor({ jsonPath, initialSlides, onRebuilt }: {
  jsonPath: string
  initialSlides: OutlineSlide[]
  onRebuilt: (file: { name: string; path: string; size: number }) => void
}) {
  const [slides, setSlides] = useState<OutlineSlide[]>(() => initialSlides.map(s => ({ layout: s.layout || 'BulletList', title: s.title || '', content: Array.isArray(s.content) ? [...s.content] : [] })))
  const [rebuilding, setRebuilding] = useState(false)
  const [error, setError] = useState('')
  const dirty = useMemo(() => JSON.stringify(slides) !== JSON.stringify(initialSlides), [slides, initialSlides])

  const patch = (i: number, p: Partial<OutlineSlide>) =>
    setSlides(prev => prev.map((s, j) => j === i ? { ...s, ...p } : s))
  const invalidIdx = slides.findIndex(s => !s.title.trim())

  const rebuild = async () => {
    if (rebuilding || invalidIdx >= 0) return
    setRebuilding(true); setError('')
    try {
      const r = await WorkshopApi.rebuildPptx({ jsonPath, slides }, { timeoutMs: 120000 })
      if (r.ok) onRebuilt(r.file)
    } catch (e: any) {
      setError(String(e?.message || e).slice(0, 200))
    } finally { setRebuilding(false) }
  }

  return (
    <div className="panel !p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-pi-text">大纲预览 · 可编辑</span>
        <span className="text-[10px] text-pi-dim2">{slides.length} 页{dirty ? ' · 有改动' : ''}</span>
        <span className="ml-auto flex items-center gap-2">
          {error && <span className="text-[11px] text-red-400 truncate max-w-56" title={error}>{error}</span>}
          <button
            className="btn-primary text-[11px] px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-50"
            disabled={rebuilding || invalidIdx >= 0}
            onClick={rebuild}
            title={invalidIdx >= 0 ? `第 ${invalidIdx + 1} 页标题为空` : '用修改后的大纲重新生成 .pptx（本地秒级）'}
          >
            {rebuilding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {rebuilding ? '重建中…' : '重新生成 PPTX'}
          </button>
        </span>
      </div>

      <div className="space-y-2 max-h-[26rem] overflow-y-auto pr-1">
        {slides.map((s, i) => (
          <div key={i} className={`rounded-pi-md border p-2.5 space-y-2 ${!s.title.trim() ? 'border-red-500/40' : 'border-pi-border-soft'} bg-pi-bg2/40`}>
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-pi-sm bg-pi-bg3 text-[10px] font-mono font-bold flex items-center justify-center text-pi-dim flex-shrink-0">{i + 1}</span>
              <ThemedSelect className="input-pi !py-1 text-[11px] w-28" value={s.layout} onChange={e => patch(i, { layout: e.target.value })}>
                {LAYOUT_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </ThemedSelect>
              <span className="text-[10px] text-pi-dim2 hidden sm:inline font-mono">{s.layout}</span>
              <button className="ml-auto touch-hit p-1 text-pi-dim2 hover:text-pi-red" title="删除此页"
                onClick={() => setSlides(prev => prev.filter((_, j) => j !== i))}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <input className="input-pi !py-1.5 text-[12px] font-medium" placeholder="页标题（必填）"
              value={s.title} onChange={e => patch(i, { title: e.target.value })} />
            <div className="space-y-1">
              {s.content.map((c, j) => (
                <div key={j} className="flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-pi-dim2 flex-shrink-0" />
                  <input className="input-pi !py-1 text-[11px]" placeholder="要点"
                    value={c} onChange={e => patch(i, { content: s.content.map((x, k) => k === j ? e.target.value : x) })} />
                  <button className="touch-hit p-0.5 text-pi-dim2 hover:text-pi-red flex-shrink-0" title="删要点"
                    onClick={() => patch(i, { content: s.content.filter((_, k) => k !== j) })}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <button className="text-[10px] text-pi-dim2 hover:text-pi-accent inline-flex items-center gap-0.5 px-1"
                onClick={() => patch(i, { content: [...s.content, ''] })}>
                <Plus className="w-3 h-3" />要点
              </button>
            </div>
          </div>
        ))}
      </div>

      <button className="text-[11px] text-pi-dim hover:text-pi-accent inline-flex items-center gap-1 px-1"
        onClick={() => setSlides(prev => [...prev, { layout: 'BulletList', title: '', content: [''] }])}>
        <Plus className="w-3.5 h-3.5" />添加一页
      </button>
    </div>
  )
}
