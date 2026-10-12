import ThemedSelect from '../../components/ThemedSelect'
import { useState } from 'react'
import useSWR from 'swr'
import { NovelApi, WsApi, withFileToken, type NovelBook, type NovelChapter } from '../../api'
import type { Artifact } from '../../types'
import type { StoryBeatInput } from '../../types'

// 素材挂载：把**别的工作台的产出**挂到这一段上。
//
// 为什么单独做一块：在此之前，连续创作能用的素材只有「角色定妆照」——因为那是设定里的一个字段。
// AI 绘画出的图、视频工坊出的片、小说工坊写的正文，明明都在同一个工作区里，
// 却一个字都进不来（只能手工复制粘贴路径）。这一块把它们接上。
//
// 三条刻意的取舍：
// - 文本素材**把内容存下来**（截断），只存路径的话，源文件一删这一段就废了；
// - 图/视频存**原始地址**，上送时由服务端内联成 base64（元枢地址上游不认，见 media-inline）；
// - 素材沿继承链生效：续写的段落默认看得见上一段挂的东西，否则"承接"只接了个句子。
const typeLabel: Record<string, string> = { image: '画面', video: '视频', text: '文本' }
const TEXT_LIMIT = 4000

export default function StoryMaterials({ materials, busy, onChange }: {
  materials: StoryBeatInput[]
  busy: boolean
  onChange: (next: StoryBeatInput[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'artifact' | 'novel'>('artifact')
  const [kind, setKind] = useState<'image' | 'video'>('image')
  const [pick, setPick] = useState('')
  const [bookId, setBookId] = useState('')
  const [chapterFile, setChapterFile] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)

  const { data: artData } = useSWR(open ? 'story-artifacts' : null, () => WsApi.artifacts(), { revalidateOnFocus: false, dedupingInterval: 15000 })
  const { data: bookData } = useSWR(open && tab === 'novel' ? 'story-novels' : null, () => NovelApi.books(), { revalidateOnFocus: false })
  const { data: detail } = useSWR(open && tab === 'novel' && bookId ? `story-novel-${bookId}` : null, () => NovelApi.detail(bookId), { revalidateOnFocus: false })

  const artifacts = (artData?.artifacts || []) as Artifact[]
  const books = (bookData?.books || []) as NovelBook[]
  const chapters = (detail?.chapters || []) as NovelChapter[]
  // 生成物目录名就是类型名（图片/视频/音频…），按扩展名兜底，避免目录命名变化就选不到
  const asMediaType = (a: Artifact): 'image' | 'video' | '' => {
    if (/image|图片/i.test(a.type) || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(a.name)) return 'image'
    if (/video|视频/i.test(a.type) || /\.(mp4|webm|mov|mkv)$/i.test(a.name)) return 'video'
    return ''
  }
  const candidates = artifacts.filter(a => asMediaType(a) === kind)
  const has = (t: string, url?: string, text?: string) => materials.some(m => m.type === t && (url ? m.url === url : m.text === text))

  const add = (item: StoryBeatInput, dup: boolean) => {
    if (dup) { setNote('这一段已经挂过同一个素材了'); return }
    onChange([...materials, item])
    setNote('')
  }

  const addArtifact = () => {
    const a = candidates.find(x => x.url === pick)
    if (!a) { setNote('先选一个产物'); return }
    const t = kind
    add({ id: `in-${Date.now().toString(36)}`, type: t, name: a.name, url: a.url, path: a.path }, has(t, a.url))
    setPick('')
  }

  const addChapter = async () => {
    if (!bookId || !chapterFile) { setNote('先选一本书和一章'); return }
    setLoading(true)
    try {
      const r = await NovelApi.chapter(bookId, chapterFile)
      const content = String(r.content || '').trim()
      if (!content) { setNote('这一章还是空的'); return }
      const book = books.find(b => b.id === bookId)
      const name = `${book?.title || bookId} · ${chapterFile}`
      const capped = content.slice(0, TEXT_LIMIT)
      // 同一章重复点会挂成两条一模一样的文本素材——去重按内容判，不按文件名
      add({ id: `in-${Date.now().toString(36)}`, type: 'text', name, text: capped }, has('text', undefined, capped))
      setChapterFile('')
      setNote(content.length > TEXT_LIMIT ? `已挂载，正文超过 ${TEXT_LIMIT} 字，只取前 ${TEXT_LIMIT} 字` : '已挂载这一章正文')
    } catch (e: any) { setNote(e?.message || '这一章没读出来') } finally { setLoading(false) }
  }

  return <div className="story-materials">
    <div className="story-materials-head">
      <span>本段素材 · {materials.length ? `${materials.length} 个` : '未挂载'}</span>
      <button className="btn-ghost" disabled={busy} onClick={() => setOpen(o => !o)}>{open ? '收起' : '从别处挂素材'}</button>
    </div>
    {materials.length > 0 && <ul className="story-material-chips">
      {materials.map(m => <li key={m.id} className="story-material-chip">
        {m.type === 'image' && m.url && <img src={withFileToken(m.url)} alt={m.name || '素材'} />}
        <span className="story-material-name" title={m.name || m.url}>{typeLabel[m.type] || m.type} · {m.name || m.url}</span>
        <button className="btn-ghost" disabled={busy} onClick={() => onChange(materials.filter(x => x.id !== m.id))}>移除</button>
      </li>)}
    </ul>}
    {open && <div className="story-material-picker">
      <div className="story-material-tabs">
        <button className={tab === 'artifact' ? 'is-active' : ''} onClick={() => setTab('artifact')}>工作台产物</button>
        <button className={tab === 'novel' ? 'is-active' : ''} onClick={() => setTab('novel')}>小说正文</button>
      </div>
      {tab === 'artifact' && <>
        <div className="story-material-row">
          <ThemedSelect aria-label="素材类型" value={kind} onChange={e => { setKind(e.target.value as 'image' | 'video'); setPick('') }}>
            <option value="image">画面</option>
            <option value="video">视频</option>
          </ThemedSelect>
          <ThemedSelect aria-label="选择产物" value={pick} onChange={e => setPick(e.target.value)}>
            <option value="">{candidates.length ? `从生成物里选（${candidates.length} 个）` : '生成物里还没有这类文件'}</option>
            {candidates.slice(0, 200).map(a => <option key={a.url} value={a.url}>{a.name}</option>)}
          </ThemedSelect>
          <button className="btn-ghost" disabled={busy || !pick} onClick={addArtifact}>挂上</button>
        </div>
        <p className="story-hint">来源：AI 绘画 / 视频工坊的产物（工作空间「生成物」）。画面素材会作为图生图/参考图，视频素材会作为 reference 输入。</p>
      </>}
      {tab === 'novel' && <>
        <div className="story-material-row">
          <ThemedSelect aria-label="选择小说" value={bookId} onChange={e => { setBookId(e.target.value); setChapterFile('') }}>
            <option value="">{books.length ? '选一本书' : '小说工坊里还没有书'}</option>
            {books.map(b => <option key={b.id} value={b.id}>{b.title || b.id}</option>)}
          </ThemedSelect>
          <ThemedSelect aria-label="选择章节" value={chapterFile} onChange={e => setChapterFile(e.target.value)} disabled={!bookId}>
            <option value="">{bookId ? (chapters.length ? '选一章' : '这本书还没有章节') : '先选书'}</option>
            {chapters.map(c => <option key={c.file} value={c.file}>{c.title || c.file}（{c.chars ?? c.size} 字）</option>)}
          </ThemedSelect>
          <button className="btn-ghost" disabled={busy || loading || !chapterFile} onClick={addChapter}>{loading ? '读取中…' : '挂上正文'}</button>
        </div>
        <p className="story-hint">正文会作为这一段的创作依据写进提示词（最多 {TEXT_LIMIT} 字），内容存在项目里，源文件删了也不影响。</p>
      </>}
      {note && <p role="status" className="story-notice">{note}</p>}
    </div>}
  </div>
}
