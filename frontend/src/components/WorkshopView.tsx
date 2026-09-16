import { useRef, useState } from 'react'
import { Package, History } from 'lucide-react'
import useSWR from 'swr'
import { WorkshopApi, withFileToken, apiUrl } from '../api'
import PptOutlineEditor, { type OutlineSlide } from './PptOutlineEditor'
import PptStudio, { type DeckPage } from './PptStudio'
import PromptSmartFill from './PromptSmartFill'
import Gallery from './Gallery'
import WorkshopModelPicker, { useWorkshopModel } from './WorkshopModelPicker'

// ── 专项长文生成器（SSE 长任务，收编自 vanilla）：08-27 起仅承载 PPT（小说已迁 NovelStudioView 书架式）──

export type Kind = 'ppt'
interface Artifact { name: string; path: string; size?: number }

export default function WorkshopView({ kind }: { kind: Kind }) {
  // PPT 表单
  const [theme, setTheme] = useState('')
  const [pages, setPages] = useState(10)
  const [style, setStyle] = useState('专业商务')
  const [audience, setAudience] = useState('')
  const [verb, setVerb] = useState('')
  // 运行态
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  // 工具进度卡片（A：实时展示 agent 执行到哪步）
  const [steps, setSteps] = useState<{ id: string; name: string; args: string; status: 'running' | 'done' | 'error'; output?: string }[]>([])
  const abortRef = useRef<(() => void) | null>(null)
  // 大纲预览/设计干预（2026-09-03）：SSE 'json' 事件带来 slides；历史可载入往期大纲
  const [outline, setOutline] = useState<{ jsonPath: string; slides: OutlineSlide[] } | null>(null)
  // 设计稿模式（HTML 路线）：引擎切换 + 逐页 HTML
  const [engine, setEngine] = useState<'html' | 'classic'>('html')
  const [themeKey, setThemeKey] = useState('navy')
  const [deck, setDeck] = useState<{ dir: string; pages: DeckPage[] } | null>(null)
  const abortHtmlRef = useRef<(() => void) | null>(null)
  const [historyLoading, setHistoryLoading] = useState('')
  const [historyError, setHistoryError] = useState('')
  const history = useSWR('ppt-history', () => WorkshopApi.pptHistory(), { revalidateOnFocus: false })
  const themes = useSWR('ppt-themes', () => WorkshopApi.pptThemes(), { revalidateOnFocus: false })
  const [distillOpen, setDistillOpen] = useState(false)
  const [distillUrl, setDistillUrl] = useState('')
  const [distillName, setDistillName] = useState('')
  const [distilling, setDistilling] = useState(false)
  const themeList = themes.data?.themes || [{ key: 'navy', label: '商务深蓝' }, { key: 'magazine', label: '杂志暖调' }, { key: 'dark', label: '暗色科技' }, { key: 'riso', label: '单色 Riso' }]
  const doDistill = async () => {
    if (distilling || !distillUrl.trim()) return
    setDistilling(true)
    try {
      const r = await WorkshopApi.distillTheme({ url: distillUrl.trim(), name: distillName.trim() })
      append(`· 已提炼主题「${r.label}」（bg ${r.tokens?.bg} / accent ${r.tokens?.accent}），已入库可选用`)
      await themes.mutate?.()
      setThemeKey(r.key)
      setDistillOpen(false); setDistillUrl(''); setDistillName('')
    } catch (e: any) {
      append('[提炼失败] ' + (e?.message || String(e)))
    } finally { setDistilling(false) }
  }
  const loadHistory = async (entry: NonNullable<typeof history.data>['entries'][number]) => {
    const json = entry.json || ''
    if (!json || historyLoading) return
    setHistoryLoading(entry.id); setHistoryError('')
    try {
      const filePath = entry.file?.path || json
      const dir = filePath.split('/').slice(0, -1).join('/')
      // HTML 历史包含顶层数组和 { slides } 两种 deck.json 形态，统一走
      // gallery 读取器，拿到完整页面 HTML 后回到设计稿预览。
      if (dir.includes('/ppthtml-')) {
        const loaded = await WorkshopApi.galleryDeck(dir)
        if (!loaded.pages?.length) throw new Error('设计稿没有可预览页面')
        setEngine('html'); setOutline(null); setDeck(loaded)
        append(`[往期] 已载入设计稿：${entry.theme || entry.id}`)
        return
      }
      const response = await fetch(withFileToken(`/api/ws/file?path=${encodeURIComponent(json)}`))
      if (!response.ok) throw new Error(`读取历史失败（${response.status}）`)
      const doc = await response.json()
      // 兼容旧版经典 PPT：ppt_data.json 是对象，新版/旧版 deck.json 可能直接是数组。
      const slides = Array.isArray(doc) ? doc : doc?.slides
      if (!Array.isArray(slides) || !slides.length) throw new Error('历史大纲为空或格式不受支持')
      setEngine('classic'); setDeck(null); setOutline({ jsonPath: json, slides })
      append(`[往期] 已载入经典 PPT 大纲：${entry.theme || entry.id}`)
    } catch (error: any) {
      setHistoryError(`载入失败：${String(error?.message || error).slice(0, 120)}`)
    } finally { setHistoryLoading('') }
  }

  const pptModel = useWorkshopModel('pi_workshop_model_ppt')
  const append = (s: string) => setLog(prev => [...prev.slice(-200), s])

  const run = () => {
    if (running) return
    if (!theme.trim()) return
    setRunning(true); setLog([]); setArtifacts([]); setSteps([]); setOutline(null)
    const body = { theme: theme.trim(), pages, style, audience, model: pptModel.value }
    let sawDone = false
    abortRef.current = WorkshopApi.run(kind, body, ev => {
      const d = ev.data || {}
      switch (ev.type) {
        case 'note': append('· ' + (d.text || '')); break
        case 'tool': {
          // 工具开始：加一张 running 卡片（A 实时进度）
          const argsText = typeof d.args === 'object' && d.args !== null
            ? (d.args.command || d.args.path || d.args.prompt || JSON.stringify(d.args).slice(0, 100))
            : String(d.args || '')
          setSteps(prev => [...prev, { id: d.id || 't' + Date.now(), name: d.name || 'tool', args: argsText, status: 'running' }])
          break
        }
        case 'tool_end': {
          setSteps(prev => prev.map(s => s.id === d.id ? { ...s, status: (d.isError ? 'error' : 'done'), output: (d.output || '').slice(0, 120) } : s))
          break
        }
        case 'delta': break // delta 是模型全文流，量太大不进日志（产物为准）
        case 'json':
          if (d.path && Array.isArray(d.slides)) { setOutline({ jsonPath: d.path, slides: d.slides }); append('[大纲] 已就绪，可在下方预览编辑') }
          break
        case 'file':
          if (d.path) { setArtifacts(prev => [...prev, d]); append(`[产物] ${d.name}`) }
          break
        case 'error': append('[错误] ' + (d.message || d.error || '未知错误')); break
        case 'done':
          sawDone = true
          if (!d.file && !artifacts.length) append(d.ok ? '[完成]' : '[警告] 流程结束，未检测到产物')
          else append('[完成]')
          setRunning(false)
          break
      }
      if (ev.type === 'done') { if (!sawDone) setRunning(false) }
    })
  }

  const stop = () => { abortRef.current?.(); abortHtmlRef.current?.(); setRunning(false); append('[已手动停止]') }

  const runHtml = () => {
    if (running || !theme.trim()) return
    setRunning(true); setLog([]); setArtifacts([]); setSteps([]); setDeck(null); setOutline(null)
    const body = { theme: theme.trim(), pages, themeKey, audience, verb: verb.trim(), model: pptModel.value }
    abortHtmlRef.current = WorkshopApi.runHtml(body, ev => {
      const d = ev.data || {}
      switch (ev.type) {
        case 'note': append('· ' + (d.text || '')); break
        case 'tool': setSteps(prev => [...prev, { id: d.id || 't' + Date.now(), name: d.name || 'tool', args: String(d.args?.command || d.args?.path || d.args?.prompt || '').slice(0, 100) || JSON.stringify(d.args || {}).slice(0, 100), status: 'running' }]); break
        case 'tool_end': setSteps(prev => prev.map(s => s.id === d.id ? { ...s, status: d.isError ? 'error' : 'done', output: (d.output || '').slice(0, 120) } : s)); break
        case 'deck_meta': setDeck({ dir: d.dir, pages: [] }); append(`[清单] ${d.count} 页 · 模板 ${d.themeKey}`); break
        case 'deck_lint':
          append(d.ok ? `[硬质检] ✓ 通过（${d.total} 个提示，0 error）` : `[硬质检] ${d.errors} 个 error / ${d.total} 个提示，详见 ${d.dir}/lint-report.json`)
          break
        case 'deck_page':
          setDeck(prev => prev ? { ...prev, pages: [...prev.pages, { file: d.file, title: d.title, layout: d.layout, html: d.html }] } : prev)
          break
        case 'error':
          append('[错误] ' + (d.message || '未知错误'))
          if (/fetch|network|failed/i.test(d.message || '')) append('· 连接中断，但后台仍在生成——稍后刷新页面从「往期」载入结果即可')
          setRunning(false)
          break
        case 'done': append(d.ok ? '[完成]' : '[警告] 流程结束，未检测到产物'); setRunning(false); break
      }
    })
  }

  return (
    <div className="space-y-4">
      {/* 作品集（设计稿 deck，扫描 workshop-out 自动收录）——创作与作品同屏 */}
      <Gallery />

      {/* 往期生成（可载入大纲再编辑/重建）*/}
      {(history.data?.entries?.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            <History className="w-3.5 h-3.5 text-pi-dim2" />
            <span className="text-pi-dim2">往期：</span>
            {history.data!.entries.slice(0, 5).map(h => {
              const isHtml = String(h.file?.path || h.json || '').includes('/ppthtml-')
              return <button key={h.id} disabled={!h.json || !!historyLoading} className="px-2 py-1 rounded-pi-pill bg-pi-bg2/60 border border-pi-border-soft text-pi-dim hover:text-pi-text hover:border-pi-accent/40 transition-colors truncate max-w-48 disabled:opacity-50"
                title={h.json ? (isHtml ? '载入设计稿预览' : '载入大纲可再编辑重建') : '无大纲快照'}
                onClick={() => h.json && loadHistory(h)}>
                {historyLoading === h.id ? '载入中…' : <>{h.theme?.slice(0, 14)}{h.theme?.length > 14 ? '…' : ''}</>}
              </button>
            })}
          </div>
          {historyError && <div className="text-[11px] text-pi-red px-1" role="alert">{historyError}</div>}
        </div>
      )}

      {/* 表单 */}
      <div className="panel !p-3 space-y-3">
          <input className="input-pi text-[13px] min-h-11" placeholder="PPT 主题，如：Q3 产品复盘汇报" value={theme} onChange={e => setTheme(e.target.value)} />
          {engine === 'html' && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <input className="input-pi text-[13px] min-h-11 w-full sm:w-40" placeholder="动词，如：对照" value={verb} onChange={e => setVerb(e.target.value)} maxLength={8} />
              <PromptSmartFill kind="html" idea={theme} onFilled={({ fields }) => { if (fields?.verb) setVerb(fields.verb) }} />
              <span className="text-[11px] text-pi-dim2">整套一个动作。空着会按主题推断。</span>
            </div>
          )}
          <div className="grid grid-cols-1 sm:flex sm:flex-wrap gap-2">
            <label className="text-xs text-pi-dim flex flex-col sm:flex-row sm:items-center gap-1.5">页数
              <input type="number" min={3} max={25} className="input-pi min-h-11 !py-2 text-xs w-full sm:w-20" value={pages} onChange={e => setPages(+e.target.value)} />
            </label>
            <label className="text-xs text-pi-dim flex flex-col sm:flex-row sm:items-center gap-1.5">风格
              <select className="input-pi min-h-11 !py-2 text-xs w-full sm:w-28" value={style} onChange={e => setStyle(e.target.value)}>
                <option>专业商务</option><option>学术汇报</option><option>简约科技</option><option>创意活泼</option><option>国风典雅</option>
              </select>
            </label>
            <label className="text-xs text-pi-dim flex flex-col sm:flex-row sm:items-center gap-1.5">受众
              <input className="input-pi min-h-11 !py-2 text-xs w-full sm:w-32" placeholder="可选" value={audience} onChange={e => setAudience(e.target.value)} />
            </label>
            <WorkshopModelPicker value={pptModel.value} onChange={pptModel.set} textModels={pptModel.textModels} />
          </div>
          {distillOpen && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 text-xs">
              <span className="text-pi-dim2">提炼：</span>
              <input className="input-pi min-h-11 !py-2 text-xs w-full sm:flex-1" placeholder="粘贴喜欢的网页 URL…" value={distillUrl} onChange={e => setDistillUrl(e.target.value)} />
              <input className="input-pi min-h-11 !py-2 text-xs w-full sm:w-28" placeholder="主题名（可选）" value={distillName} onChange={e => setDistillName(e.target.value)} />
              <button className="btn-primary text-xs px-3 min-h-11 w-full sm:w-auto disabled:opacity-50" disabled={distilling || !distillUrl.trim()} onClick={doDistill}>
                {distilling ? '提炼中…' : '生成模板'}
              </button>
            </div>
          )}
          {/* 引擎切换 */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="inline-flex rounded-pi-md border border-pi-border-soft overflow-hidden w-full sm:w-auto">
              {([['html', '设计稿'], ['classic', '经典 PPT']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setEngine(k)}
                  className={`flex-1 sm:flex-none min-h-11 px-3 text-[11px] transition-colors ${engine === k ? 'bg-pi-accent text-pi-on-accent font-medium' : 'text-pi-dim hover:text-pi-text hover:bg-pi-bg-hover'}`}>
                  {label}
                </button>
              ))}
            </div>
            {engine === 'html' && (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="text-xs text-pi-dim flex flex-col sm:flex-row sm:items-center gap-1.5">模板
                  <select className="input-pi min-h-11 !py-2 text-xs w-full sm:w-32" value={themeKey} onChange={e => setThemeKey(e.target.value)}>
                    {themeList.map(t => <option key={t.key} value={t.key}>{t.label}{t.builtin === false ? '' : ''}</option>)}
                  </select>
                </label>
                <button className="min-h-11 text-[11px] px-3 rounded-pi-md border border-dashed border-pi-border-soft text-pi-dim hover:text-pi-accent hover:border-pi-accent/50 transition-colors w-full sm:w-auto"
                  onClick={() => setDistillOpen(v => !v)} title="从喜欢的网页提取配色与字体，生成新模板">从网址提炼模板</button>
              </div>
            )}
          </div>
      </div>

      {/* 运行条 */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        {running
          ? <button className="min-h-11 w-full sm:w-auto px-4 rounded-pi-md bg-red-500/90 text-white text-xs font-medium" onClick={stop}>停止</button>
          : <button className="btn-primary text-xs px-4 min-h-11 w-full sm:w-auto" onClick={engine === 'html' ? runHtml : run}>{engine === 'html' ? '开始生成设计稿' : '开始生成 PPT'}</button>}
        <span className="text-[11px] text-pi-dim2 leading-relaxed">{engine === 'html' ? '每页一张设计过的 HTML 画布，浏览器真渲染，可改文案/导出 PDF' : '走 ppt-generator 技能全流程，产出可二次编辑的 .pptx'}</span>
      </div>

      {/* 执行进度（A：agent 步骤卡片，实时看到执行到哪步）*/}
      {steps.length > 0 && (
        <div className="space-y-1.5">
          {steps.map((s, i) => (
            <div key={s.id || i} className="panel !p-2.5 flex items-start gap-2.5">
              <span className={`mt-0.5 w-5 h-5 rounded-pi-sm flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${s.status === 'running' ? 'bg-pi-accent/20 text-pi-accent' : s.status === 'error' ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-300'}`}>
                {s.status === 'running' ? <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-pi-accent/25 border-t-pi-accent animate-spin"/> : s.status === 'error' ? '✕' : '✓'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-mono font-semibold text-pi-text">{s.name}</span>
                  <span className={`text-[10px] ${s.status === 'running' ? 'text-pi-accent' : s.status === 'error' ? 'text-red-400' : 'text-pi-dim2'}`}>{s.status === 'running' ? '执行中' : s.status === 'error' ? '出错' : '完成'}</span>
                </div>
                {s.args && <div className="text-[11px] text-pi-dim font-mono truncate mt-0.5">{s.args}</div>}
                {s.output && <div className="text-[11px] text-pi-dim2 mt-0.5 line-clamp-2">{s.output}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 过程日志 */}
      {log.length > 0 && (
        <div className="panel !p-3 max-h-56 overflow-y-auto font-mono text-[12px] leading-relaxed">
          {log.map((l, i) => (
            <div key={i} className={l.startsWith('[错误]') ? 'text-red-400' : l.startsWith('[完成]') || l.startsWith('[产物]') ? 'text-emerald-300' : l.startsWith('[警告]') ? 'text-amber-300' : 'text-pi-dim'}>{l}</div>
          ))}
        </div>
      )}

      {/* 设计稿预览（HTML 路线核心：真渲染 + 文案干预 + PDF 导出）*/}
      {engine === 'html' && deck && deck.pages.length > 0 && (
        <PptStudio pages={deck.pages} dir={deck.dir} />
      )}

      {/* 大纲预览 / 设计干预（经典路线）：生成完（或从历史载入）后可编辑重建 */}
      {outline && (
        <PptOutlineEditor
          jsonPath={outline.jsonPath}
          initialSlides={outline.slides}
          onRebuilt={file => {
            setArtifacts(prev => [file, ...prev.filter(a => a.path !== file.path)])
            append(`[重建] ${file.name}（${(file.size / 1024).toFixed(0)} KB）`)
            history.mutate()
          }}
        />
      )}

      {/* 产物 */}
      {artifacts.length > 0 && (
        <div className="space-y-1.5">
          {artifacts.map(a => (
            <a key={a.path} href={withFileToken(`/api/ws/file?path=${encodeURIComponent(a.path)}`)} target="_blank" rel="noreferrer"
              className="panel !p-3 flex items-center gap-2.5 glow-hover">
              <Package className="w-4 h-4 flex-shrink-0" />
              <span className="text-[13px] text-pi-text flex-1 truncate">{a.name}</span>
              {a.size ? <span className="text-[10px] text-pi-dim2">{(a.size / 1024).toFixed(0)} KB</span> : null}
              <span className="text-xs text-pi-accent">下载 ↗</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
