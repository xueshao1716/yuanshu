import { useState } from 'react'
import useSWR from 'swr'
import { BookOpen, Library, Plus, Trash2 } from 'lucide-react'
import { NovelApi, type NovelBook } from '../../api'

const GENRES: [string, string][] = [['xianxia', '仙侠'], ['urban', '都市'], ['scifi', '科幻'], ['history', '历史'], ['mystery', '悬疑'], ['horror', '恐怖']]
const NARRATORS = ['第三人称', '第一人称', '上帝视角']
const STATUS: [string, string][] = [['', '全部'], ['draft', '草稿'], ['building', '构建中'], ['writing', '连载'], ['revising', '修订'], ['archived', '归档']]
const genreLabel = (g: string) => GENRES.find(([k]) => k === g)?.[1] || g
const statusLabel = (s?: string) => STATUS.find(([k]) => k === s)?.[1] || '草稿'
const narratorSuffix = (n?: string) => (n && n !== '第三人称' ? ` · ${n}` : '')

export default function NovelShelf({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, mutate, isLoading } = useSWR('novel-books', () => NovelApi.books(), { revalidateOnFocus: false })
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState('')
  const [form, setForm] = useState({ title: '', genre: 'xianxia', narrator: '第三人称', protagonist: '', setting: '' })
  const [busy, setBusy] = useState(false)
  const books: NovelBook[] = (data?.books || []).filter(b => !filter || b.status === filter)

  const submit = async () => {
    if (!form.title.trim() || busy) return
    setBusy(true)
    try {
      const r = await NovelApi.create({
        title: form.title.trim(), genre: form.genre, narrator: form.narrator,
        protagonist: form.protagonist.trim(), setting: form.setting.trim(),
      })
      if (r.id) { await mutate(); onOpen(r.id); setCreating(false); setForm({ title: '', genre: 'xianxia', narrator: '第三人称', protagonist: '', setting: '' }) }
    } finally { setBusy(false) }
  }

  const remove = async (e: React.MouseEvent, b: NovelBook) => {
    e.stopPropagation()
    if (!confirm(`删除《${b.title}》？章节和设定都会清掉。`)) return
    await NovelApi.remove(b.id)
    await mutate()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <button className="btn-primary text-xs px-3.5 min-h-11 w-full sm:w-auto flex items-center justify-center gap-1.5" onClick={() => setCreating(v => !v)}>
          <Plus className="w-3.5 h-3.5" />新建作品
        </button>
        <span className="text-[11px] text-pi-dim2">{data?.books?.length || 0} 本 · 按管道节点推进</span>
        <div className="flex gap-1 overflow-x-auto pb-0.5 sm:ml-auto">
          {STATUS.map(([k, l]) => (
            <button key={k || 'all'} onClick={() => setFilter(k)}
              className={`px-3 min-h-11 rounded-full text-[11px] border whitespace-nowrap ${filter === k ? 'bg-pi-accent text-pi-on-accent border-pi-accent' : 'text-pi-dim border-pi-border-soft'}`}>{l}</button>
          ))}
        </div>
      </div>

      {creating && (
        <div className="panel !p-3 space-y-2.5">
          <input className="input-pi min-h-11 text-[13px]" placeholder="书名 *" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          <div className="grid grid-cols-1 sm:flex sm:flex-wrap gap-2">
            <label className="text-xs text-pi-dim flex flex-col sm:flex-row sm:items-center gap-1.5">题材
              <select className="input-pi min-h-11 !py-2 text-xs w-full sm:w-24" value={form.genre} onChange={e => setForm(f => ({ ...f, genre: e.target.value }))}>
                {GENRES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="text-xs text-pi-dim flex flex-col sm:flex-row sm:items-center gap-1.5">叙事
              <select className="input-pi min-h-11 !py-2 text-xs w-full sm:w-24" value={form.narrator} onChange={e => setForm(f => ({ ...f, narrator: e.target.value }))}>
                {NARRATORS.map(n => <option key={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <input className="input-pi min-h-11 text-[13px]" placeholder="主角设定（可选）" value={form.protagonist} onChange={e => setForm(f => ({ ...f, protagonist: e.target.value }))} />
          <textarea className="input-pi text-[13px] min-h-[60px] resize-y" placeholder="世界观/金手指（可选）" value={form.setting} onChange={e => setForm(f => ({ ...f, setting: e.target.value }))} />
          <div className="flex justify-stretch sm:justify-end"><button className="btn-primary text-xs px-4 min-h-11 w-full sm:w-auto disabled:opacity-50" disabled={!form.title.trim() || busy} onClick={submit}>{busy ? '创建中…' : '建档'}</button></div>
        </div>
      )}

      {!isLoading && books.length === 0 && !creating && (
        <div className="panel !p-8 text-center">
          <Library className="w-8 h-8 mx-auto text-pi-dim2 mb-2" strokeWidth={1.5} />
          <p className="text-[13px] text-pi-dim">书架空空——建一本，从产品化开始</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {books.map(b => (
          <button key={b.id} onClick={() => onOpen(b.id)} className="panel !p-3.5 text-left glow-hover group relative">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 w-9 h-9 rounded-pi-sm bg-pi-accent/15 flex items-center justify-center flex-shrink-0">
                <BookOpen className="w-4 h-4 text-pi-accent" strokeWidth={1.8} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-pi-text truncate group-hover:text-pi-accent transition-colors duration-fast">《{b.title}》</div>
                <div className="text-[11px] text-pi-dim mt-0.5">{genreLabel(b.genre)} · {statusLabel(b.status)} · {b.chapters} 章{narratorSuffix(b.narrator)}</div>
                <div className="text-[11px] text-pi-dim2 mt-0.5">管道 {b.pipelineReady ?? 0}/{b.pipelineTotal ?? 0}</div>
                {b.protagonist && <div className="text-[11px] text-pi-dim2 truncate mt-0.5">{b.protagonist}</div>}
              </div>
              <span role="button" tabIndex={0} className="touch-hit p-1.5 rounded-pi-md text-pi-dim2 hover:text-pi-red" title="删除"
                onClick={e => remove(e, b)} onKeyDown={e => { if (e.key === 'Enter') remove(e as any, b) }}>
                <Trash2 className="w-3.5 h-3.5" />
                <span className="sr-only">删除</span>
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
