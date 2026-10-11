import { useState } from 'react'
import useSWR from 'swr'
import { WorkshopApi } from '../api'
import PptStudio, { type DeckPage } from './PptStudio'
import ScaledSlide from './ScaledSlide'
import { Presentation, ChevronDown } from 'lucide-react'

// ── 作品集（创作工坊产品化第一步）：扫描 workshop-out，落盘即收录 ──
// 卡片封面 = 首页 HTML 真渲染缩略（ScaledSlide 自适应宽度）；点卡片展开 PptStudio（预览/放映/改文案/导 PDF）

function DeckCard({ item, onOpen }: { item: { id: string; dir: string; title: string; pages: number; themeKey: string; ts: number; cover: string }; onOpen: () => void }) {
  const { data } = useSWR(`gal-cover:${item.id}`, () =>
    fetch(WorkshopApi.galleryDeckUrl(item.dir, item.cover)).then(r => r.ok ? r.text() : ''), { revalidateOnFocus: false })
  const date = new Date(item.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  return (
    <button className="group panel !p-2 text-left flex flex-col gap-1.5 card-hover" onClick={onOpen}>
      <div className="rounded-pi-md bg-pi-bg3/60 overflow-hidden relative">
        {data
          ? <ScaledSlide html={data} title={item.title} />
          : <div className="w-full aspect-[16/9] flex items-center justify-center animate-pulse"><Presentation className="w-8 h-8 opacity-30" /></div>}
      </div>
      <div className="text-[12px] text-pi-text truncate px-0.5" title={item.title}>{item.title}</div>
      <div className="flex items-center gap-1.5 text-[10px] text-pi-dim2 px-0.5">
        <span className="px-1.5 py-0.5 rounded-pi-pill bg-pi-bg3">{item.pages} 页</span>
        {item.themeKey && <span className="px-1.5 py-0.5 rounded-pi-pill bg-pi-bg3">{item.themeKey}</span>}
        <span className="ml-auto">{date}</span>
      </div>
    </button>
  )
}

export default function Gallery() {
  const { data } = useSWR('gallery', () => WorkshopApi.galleryList(), { revalidateOnFocus: true, dedupingInterval: 15000 })
  const items = (data?.items || []).filter(i => i.kind === 'deck')
  const [openDir, setOpenDir] = useState<string | null>(null)
  const deck = useSWR(openDir ? `gal-deck:${openDir}` : null, () => WorkshopApi.galleryDeck(openDir!), { revalidateOnFocus: false })
  const openItem = items.find(i => i.dir === openDir)

  if (!items.length) return null
  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-pi-text mb-2 inline-flex items-center gap-1.5"><Presentation className="w-4 h-4" /> 作品 · 设计稿</h2>
      <div className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {items.map(i => <DeckCard key={i.id} item={i} onOpen={() => setOpenDir(i.dir)} />)}
      </div>
      {openDir && (
        <div className="fixed inset-0 z-[var(--pi-z-viewer)] bg-black/80 flex items-start justify-center p-4 sm:p-8 overflow-y-auto" onClick={() => setOpenDir(null)}>
          <div className="w-[min(96vw,1600px)] max-h-[94vh] overflow-y-auto panel !bg-pi-bg !p-4 space-y-3 rounded-pi-lg" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-pi-text truncate flex-1">{openItem?.title || openDir}</span>
              <button className="btn-tool !py-1" onClick={() => setOpenDir(null)}><ChevronDown className="w-4 h-4" />收起</button>
            </div>
            {deck.data
              ? <PptStudio pages={deck.data.pages as DeckPage[]} dir={openDir} onSaved={() => { deck.mutate?.() }} />
              : <div className="py-16 text-center text-xs text-pi-dim2 animate-pulse">加载作品页…</div>}
          </div>
        </div>
      )}
    </div>
  )
}
