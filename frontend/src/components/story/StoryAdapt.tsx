import ThemedSelect from '../../components/ThemedSelect'
import { useState } from 'react'
import useSWR from 'swr'
import { NovelApi, StoryApi, type NovelBook, type NovelChapter } from '../../api'
import type { StoryAdaptResult, StoryProject } from '../../types'

// 原著改编：小说原文 → 分集大纲（集 + 场 + 段）一次落进项目。
//
// 对照 PINNGOO 的「小说转分集短剧」四步（导入原著 → 总览/人物关系/分集大纲 → 批量分集剧本 → 视觉制作）
// 与 Laper 的整本剧本上下文：元枢此前只能把小说工坊的**某一章**当文本素材挂在某一段上，
// 一整本书进来仍是一个大平铺，用户得自己数着第几场属于第几集 —— "分集"这一层根本没有。
//
// 三条刻意的取舍：
// - **先预览再花钱**：预览只读书、只报字数与章节，一次模型调用都不发；
// - **原文会截断，就必须说清**：超过 6 万字只取前 6 万字，界面照实显示，不让人以为整本都改编了；
// - **解析不全不算整体失败**：能出几集就落几集，哪几集没出来、模型第一次少给了几集，全部如实显示。
const SOURCE_CAP = 60000

export default function StoryAdapt({ project, busy, onDone }: {
  project: StoryProject
  busy: boolean
  onDone: (project: StoryProject) => void
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'text' | 'novel'>('text')
  const [sourceText, setSourceText] = useState('')
  const [bookId, setBookId] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [episodes, setEpisodes] = useState('4')
  const [seconds, setSeconds] = useState('90')
  const [idea, setIdea] = useState('')
  const [result, setResult] = useState<StoryAdaptResult | null>(null)
  const [msg, setMsg] = useState('')
  const [running, setRunning] = useState(false)

  const { data: bookData } = useSWR(open && mode === 'novel' ? 'story-adapt-novels' : null, () => NovelApi.books(), { revalidateOnFocus: false })
  const { data: detail } = useSWR(open && mode === 'novel' && bookId ? `story-adapt-book-${bookId}` : null, () => NovelApi.detail(bookId), { revalidateOnFocus: false })
  const books = (bookData?.books || []) as NovelBook[]
  const chapters = (detail?.chapters || []) as NovelChapter[]
  const pickedChars = mode === 'novel'
    ? chapters.filter(c => files.includes(c.file)).reduce((n, c) => n + (c.chars || 0), 0)
    : sourceText.trim().length
  const over = pickedChars > SOURCE_CAP
  const canRun = !busy && !running && pickedChars > 0
  const history = project.adaptations || []

  const send = async (preview: boolean) => {
    setMsg(''); setRunning(true)
    try {
      const r = await StoryApi.adapt(project.id, {
        ...(mode === 'text' ? { sourceText } : { bookId, chapterFiles: files }),
        episodes: Number(episodes) || undefined,
        secondsPerEpisode: Number(seconds) || undefined,
        idea: idea.trim() || undefined,
        preview,
      })
      setResult(r)
      if (preview) setMsg(r.note || '已读取原文')
      else {
        if (r.project) onDone(r.project)
        const parts = [`已改编出 ${r.episodeCount || 0} 集 / ${r.sceneCount || 0} 场 / ${r.beatCount || 0} 段`]
        if (r.retried) parts.push('模型第一次给的集数不够，已自动再要了一次')
        if (r.firstEpisodeCount && r.firstEpisodeCount !== r.episodeCount) parts.push(`第一次只给了 ${r.firstEpisodeCount} 集`)
        if (r.incomplete?.length) parts.push(`未解析出来：${r.incomplete.join('、')}`)
        if (r.short) parts.push('集数仍少于要求，可以再点一次或把改编要求写具体些')
        setMsg(parts.join('；'))
      }
    } catch (e: any) {
      setMsg(e?.message || (preview ? '预览没成功' : '改编没成功'))
    } finally { setRunning(false) }
  }

  const toggleFile = (file: string) => setFiles(prev => prev.includes(file) ? prev.filter(f => f !== file) : [...prev, file])
  const shown = result?.source
  const created = result?.episodesCreated || []

  return <div className="story-adapt">
    <div className="story-head">
      <span>原著改编{history.length ? ` · 改编过 ${history.length} 次` : ''}</span>
      <button className="btn-ghost" disabled={busy} onClick={() => setOpen(o => !o)}>{open ? '收起' : '导入原著'}</button>
    </div>
    {open && <div className="story-adapt-body">
      <p className="story-hint">
        把小说原文交给改编编剧，一次产出<strong>分集大纲</strong>：每集有标题与梗概，每集下面挂好场与段落（含台词），
        并登记人物与关系。段落类型由改编决定（文字/画面/视频），不会被项目默认配方一律抹平成同一种。
      </p>
      <div className="story-adapt-modes">
        <button className={mode === 'text' ? 'btn-ghost on' : 'btn-ghost'} disabled={running} onClick={() => setMode('text')}>粘贴正文</button>
        <button className={mode === 'novel' ? 'btn-ghost on' : 'btn-ghost'} disabled={running} onClick={() => setMode('novel')}>从小说工坊导入</button>
      </div>
      {mode === 'text' ? <textarea aria-label="小说原文" rows={8} value={sourceText} disabled={running} placeholder="把小说正文粘贴进来（建议一次一章或一个完整段落，超长会截断）" onChange={e => setSourceText(e.target.value)} />
        : <div className="story-adapt-novel">
          <ThemedSelect aria-label="选择小说" value={bookId} disabled={running} onChange={e => { setBookId(e.target.value); setFiles([]) }}>
            <option value="">选一本书…</option>
            {books.map(b => <option key={b.id} value={b.id}>{b.title || b.id}</option>)}
          </ThemedSelect>
          {bookId && !chapters.length && <p className="story-hint">这本书还没有章节。</p>}
          {chapters.length > 0 && <>
            <div className="story-adapt-chapters">
              {chapters.map(c => <label key={c.file}>
                <input type="checkbox" checked={files.includes(c.file)} disabled={running} onChange={() => toggleFile(c.file)} />
                <span>{c.title || c.file}</span><span>{c.chars || 0} 字</span>
              </label>)}
            </div>
            <div className="story-adapt-bulk">
              <button className="btn-ghost" disabled={running} onClick={() => setFiles(chapters.map(c => c.file))}>全选</button>
              <button className="btn-ghost" disabled={running} onClick={() => setFiles([])}>清空</button>
              <span>不选 = 改编整本</span>
            </div>
          </>}
        </div>}
      <div className="story-adapt-opts">
        <label>集数<input aria-label="集数" value={episodes} disabled={running} onChange={e => setEpisodes(e.target.value.replace(/[^0-9]/g, ''))} /></label>
        <label>单集秒数<input aria-label="单集秒数" value={seconds} disabled={running} onChange={e => setSeconds(e.target.value.replace(/[^0-9]/g, ''))} /></label>
        <span className={over ? 'story-adapt-warn' : ''}>
          {pickedChars ? `原文 ${pickedChars} 字${over ? `（超 ${SOURCE_CAP} 字上限，只取前 ${SOURCE_CAP} 字）` : ''}` : '还没有原文'}
        </span>
      </div>
      <input aria-label="改编要求" value={idea} disabled={running} placeholder="改编要求（可留空）：如保留双男主、加快节奏、第一集结尾留反转" onChange={e => setIdea(e.target.value)} />
      <div className="story-adapt-actions">
        <button className="btn-ghost" disabled={!pickedChars || running} onClick={() => send(true)}>{running ? '处理中…' : '预览（不调模型）'}</button>
        <button disabled={!canRun} onClick={() => send(false)}>{running ? '改编中…' : '生成分集大纲'}</button>
      </div>
      {msg && <p role="status" className="story-notice">{msg}</p>}
      {shown && <div className="story-adapt-source">
        <div className="story-adapt-source-head">
          原文来源：{shown.kind === 'novel' ? `小说工坊 · ${shown.title || shown.bookId}（${shown.chapters.length} 章）` : shown.kind === 'text' ? '粘贴正文' : '无'}
          {shown.kind === 'novel' && <span> · {(shown.chapters || []).map(c => `${c.title} ${c.chars}字`).join('、')}</span>}
        </div>
      </div>}
      {result?.overview?.logline && <p className="story-adapt-logline">梗概：{result.overview.logline}</p>}
      {!!result?.overview?.relationships?.length && <ul className="story-adapt-relations">
        {result.overview.relationships.map((r, i) => <li key={i}>{r.from} → {r.to}{r.note ? `：${r.note}` : ''}</li>)}
      </ul>}
      {created.length > 0 && <ul className="story-adapt-episodes">
        {created.map(e => <li key={e.id}><strong>第 {e.no} 集 · {e.title}</strong><span>{e.sceneCount} 场</span>
          {e.summary && <p>{e.summary}</p>}</li>)}
      </ul>}
      {history.length > 0 && <details className="story-adapt-history">
        <summary>改编记录（{history.length}）</summary>
        <ul>{[...history].reverse().map(a => <li key={a.id}>
          <span>{a.at?.replace('T', ' ').slice(0, 16)}</span>
          <span>{a.source?.kind === 'novel' ? `《${a.source.title || a.source.bookId}》${a.source.chapters?.length || 0} 章` : '粘贴正文'}</span>
          <span>{a.source?.chars || 0} 字{a.source?.truncated ? `（实际用 ${a.source.usedChars}）` : ''}</span>
          <span>{a.episodeCount} 集 / {a.sceneCount} 场 / {a.beatCount} 段</span>
          {a.model?.id && <span>{a.model.id}</span>}
        </li>)}</ul>
      </details>}
    </div>}
  </div>
}
