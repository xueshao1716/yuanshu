import { useEffect, useMemo, useRef, useState } from 'react'
import { Printer, Pencil, Check, Loader2, X, Play, ChevronLeft, ChevronRight, Maximize } from 'lucide-react'
import { WorkshopApi } from '../api'
import ScaledSlide from './ScaledSlide'

// ── PPT 设计稿工作室（2026-09-03，对标扣子/Gamma 网页 PPT）──
// 每页是 agent 产出的 1280×720 自包含 HTML：缩略图 iframe 真渲染（所见即所得），
// 文案通过 data-field 定位替换（保设计改文案），导出走浏览器打印（@page 16:9）。

export interface DeckPage { file: string; title: string; layout: string; html: string }



function setField(html: string, field: string, value: string) {
  // 在该 data-field 节点的开标签后替换首个文本段（到下一个 < 为止）
  const re = new RegExp(`(data-field="${field}"[^>]*>)([^<]*)(<)`)
  if (re.test(html)) return html.replace(re, `$1${value.replace(/[<>&]/g, '')}$3`)
  return html
}

export default function PptStudio({ pages, dir, onSaved }: {
  pages: DeckPage[]
  dir: string
  onSaved?: () => void
}) {
  const [active, setActive] = useState(0)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<DeckPage | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // 放映模式（全屏翻页播放）
  const [playing, setPlaying] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const fullRef = useRef<HTMLDivElement>(null)
  // AI 改页：本地覆盖层热更新 + 提交到 refine SSE
  const [refineInstr, setRefineInstr] = useState('')
  const [refining, setRefining] = useState(false)
  const [refineMsg, setRefineMsg] = useState('')
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const refineAbortRef = useRef<(() => void) | null>(null)
  useEffect(() => () => refineAbortRef.current?.(), [])
  const mergedPages = useMemo(() => pages.map(p => ({ ...p, html: overrides[p.file] ?? p.html })), [pages, overrides])
  const [fscale, setFscale] = useState(1)

  useEffect(() => {
    if (!playing) return
    const el = stageRef.current
    if (!el) return
    const fit = () => setFscale(Math.min(el.clientWidth / 1280, el.clientHeight / 720))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [playing])

  useEffect(() => {
    if (!playing) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); setActive(i => Math.min(i + 1, mergedPages.length - 1)) }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
      else if (e.key === 'Escape') setPlaying(false)
      else if (e.key === 'Home') setActive(0)
      else if (e.key === 'End') setActive(mergedPages.length - 1)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [playing, mergedPages.length])

  const fields = useMemo(() => {
    const src = editing && draft ? draft.html : mergedPages[active]?.html || ''
    const out: { field: string; value: string }[] = []
    const re = /data-field="([^"]+)"[^>]*>([^<]*)</g
    let m
    while ((m = re.exec(src))) out.push({ field: m[1], value: m[2] })
    return out
  }, [pages, active, editing, draft])

  useEffect(() => { setDraft(null); setEditing(false) }, [active, pages])

  const startEdit = () => { setDraft({ ...mergedPages[active] }); setEditing(true) }
  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    try {
      await WorkshopApi.saveHtmlPage({ file: draft.file, html: draft.html, title: draft.title })
      setEditing(false); setDraft(null); onSaved?.()
    } catch {} finally { setSaving(false) }
  }

  const printDeck = () => {
    const w = window.open('', '_blank')
    if (!w) return
    const style = `<style>@page{size:1280px 720px;margin:0}body{margin:0}.pg{width:1280px;height:720px;overflow:hidden;page-break-after:always}iframe{border:0;width:1280px;height:720px;display:block}</style>`
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${
      mergedPages.map(p => `<div class="pg"><iframe srcdoc="${p.html.replace(/"/g, '&quot;')}"></iframe></div>`).join('')
    }<script>window.onload=()=>setTimeout(()=>window.print(),600)</script></body></html>`)
    w.document.close()
  }


  const doRefine = () => {
    if (refining || !refineInstr.trim() || !dir) return
    const target = mergedPages[active]
    setRefining(true); setRefineMsg('…')
    let model: string | undefined
    try { model = localStorage.getItem('pi_workshop_model_ppt') || undefined } catch {}
    refineAbortRef.current = WorkshopApi.refinePage({ dir, file: target.file, instruction: refineInstr.trim(), model }, ev => {
      const d = ev.data || {}
      switch (ev.type) {
        case 'note': setRefineMsg('· ' + (d.text || '').slice(0, 80)); break
        case 'tool': setRefineMsg('· AI 调用 ' + (d.name || '') + '…'); break
        case 'page_html': setOverrides(prev => ({ ...prev, [d.file]: d.html })); break
        case 'done':
          setRefining(false)
          if (d.changed) { setRefineMsg(`✓ 已更新${d.lintCount ? `（质检 ${d.lintCount} 条提示）` : '（质检通过）'}`); setRefineInstr(''); onSaved?.() }
          else { setRefineMsg('⚠ ' + (d.message || '页面未变化')) }
          break
        case 'error': setRefining(false); setRefineMsg('✗ ' + (d.message || '未知错误')); break
      }
    })
  }

  if (!mergedPages.length) return null
  const cur = editing && draft ? draft : mergedPages[active]
  return (
    <div className="space-y-3">
      {/* 放映层（全屏遮罩 + 自适应缩放 + 键盘/点击翻页）*/}
      {playing && (
        <div className="fixed inset-0 z-50 bg-black/95 select-none">
          <div ref={stageRef} className="absolute inset-0 flex items-center justify-center p-6">
            <div className="relative shadow-2xl shadow-black/60 rounded-sm overflow-hidden"
              style={{ width: 1280 * fscale, height: 720 * fscale }}>
              <iframe key={pages[active].file} srcDoc={mergedPages[active].html}
                style={{ width: 1280, height: 720, border: 0, transform: `scale(${fscale})`, transformOrigin: 'top left' }}
                sandbox="" title={mergedPages[active].title} />
            </div>
          </div>
          {/* 翻页热区：左 1/3 上一页，右 2/3 下一页（移动端可点）*/}
          <button className="absolute left-0 top-0 h-full w-1/3 cursor-w-resize" aria-label="上一页" onClick={() => setActive(i => Math.max(i - 1, 0))} />
          <button className="absolute right-0 top-0 h-full w-2/3 cursor-e-resize" aria-label="下一页" onClick={() => setActive(i => Math.min(i + 1, mergedPages.length - 1))} />
          {/* 顶部信息 + 关闭 */}
          <div className="absolute top-0 inset-x-0 flex items-center gap-2 px-4 py-3 bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
            <span className="text-[13px] text-white/80 font-medium truncate">{mergedPages[active].title || mergedPages[active].file}</span>
            <span className="font-mono text-[11px] text-white/45">{active + 1} / {pages.length}</span>
            <button className="ml-auto pointer-events-auto touch-hit p-1.5 text-white/60 hover:text-white" onClick={() => setPlaying(false)}><X className="w-5 h-5" /></button>
          </div>
          {/* 底部控制 */}
          <div className="absolute bottom-0 inset-x-0 flex items-center justify-center gap-3 pb-4">
            <button className="touch-hit p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 disabled:opacity-30" disabled={active === 0} onClick={() => setActive(i => Math.max(i - 1, 0))}><ChevronLeft className="w-5 h-5" /></button>
            <span className="font-mono text-[12px] text-white/50">← → 翻页 · Esc 退出</span>
            <button className="touch-hit p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 disabled:opacity-30" disabled={active === pages.length - 1} onClick={() => setActive(i => Math.min(i + 1, mergedPages.length - 1))}><ChevronRight className="w-5 h-5" /></button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-pi-text">设计稿预览</span>
        <span className="text-[10px] text-pi-dim2">{pages.length} 页 · 1280×720</span>
        <span className="ml-auto flex items-center gap-1.5">
          {editing
            ? <>
              <button className="btn-primary text-[11px] px-3 py-1.5 inline-flex items-center gap-1.5" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}保存修改
              </button>
              <button className="text-[11px] text-pi-dim2 hover:text-pi-text" onClick={() => { setEditing(false); setDraft(null) }}>取消</button>
            </>
            : <>
              <button className="text-[11px] px-2.5 py-1.5 rounded-pi-md border border-pi-border-soft text-pi-dim hover:text-pi-text inline-flex items-center gap-1" onClick={startEdit}>
                <Pencil className="w-3.5 h-3.5" />改文案
              </button>
              <button className="text-[11px] px-2.5 py-1.5 rounded-pi-md border border-pi-border-soft text-pi-dim hover:text-pi-text inline-flex items-center gap-1" onClick={() => setPlaying(true)}>
                <Play className="w-3.5 h-3.5" />放映
              </button>
              <button className="text-[11px] px-2.5 py-1.5 rounded-pi-md border border-pi-border-soft text-pi-dim hover:text-pi-text inline-flex items-center gap-1" onClick={printDeck} title="浏览器打印为 PDF（16:9 矢量）">
                <Printer className="w-3.5 h-3.5" />导出 PDF
              </button>
            </>}
        </span>
      </div>

      {/* 缩略图行（2026-10-11：手机端从固定 282px 改为 40vw，不再撑爆横向空间）*/}
      <div ref={boxRef} className="flex gap-2 overflow-x-auto pb-1">
        {pages.map((p, i) => (
          <button key={p.file} onClick={() => setActive(i)}
            className={`flex-shrink-0 w-[40vw] max-w-[282px] rounded-pi-md overflow-hidden border-2 transition-colors ${i === active ? 'border-pi-accent' : 'border-transparent hover:border-pi-border'}`}
            title={p.title}>
            <ScaledSlide html={p.html} title={p.title} />
          </button>
        ))}
      </div>

      {/* 大预览 + 编辑面板 */}
      <div className="grid lg:grid-cols-[1fr_260px] gap-3 items-start">
        <div ref={fullRef} className="ppt-stage rounded-pi-md overflow-hidden border border-pi-border-soft bg-black/20 relative">
          {/* 2026-10-11：改 ScaledSlide —— 原 width:100% 无缩放变换，手机上等效放大 3.5 倍只看得到页面左上角 */}
          <ScaledSlide key={cur.file + (editing ? '-edit' : '')} html={editing && draft ? draft.html : mergedPages[active].html} title={cur.title} />
          {!editing && (
            <button className="absolute inset-0 w-full flex items-center justify-center bg-black/0 hover:bg-black/25 group/play transition-colors"
              onClick={() => setPlaying(true)} title="点击放映">
              <span className="w-14 h-14 rounded-full bg-black/45 text-white flex items-center justify-center opacity-0 group-hover/play:opacity-100 transition-opacity">
                <Play className="w-7 h-7" />
              </span>
            </button>
          )}
          {!editing && (
            <button className="absolute top-2 right-2 p-2 rounded-pi-md bg-black/50 text-white/85 hover:text-white hover:bg-black/70 opacity-0 group-hover/play:opacity-100 transition-opacity"
              title="全屏预览（Esc 退出）" onClick={(e) => {
                e.stopPropagation()
                const el = fullRef.current as any
                if (el?.requestFullscreen) el.requestFullscreen().catch(() => setPlaying(true))
                else setPlaying(true)
              }}>
              <Maximize className="w-5 h-5" />
            </button>
          )}
        </div>
        <div className="panel !p-3 space-y-2">
          {editing && draft ? (
            <>
              <div className="text-[11px] font-semibold text-pi-dim">文案编辑（保持设计不动）</div>
              {fields.map((f, i) => (
                <label key={f.field + i} className="block">
                  <span className="text-[10px] font-mono text-pi-dim2">{f.field}</span>
                  <input className="input-pi !py-1 text-[12px]" value={f.value}
                    onChange={e => setDraft(prev => prev ? { ...prev, html: setField(prev.html, f.field, e.target.value) } : prev)} />
                </label>
              ))}
              {!fields.length && <div className="text-[11px] text-pi-dim2">此页无可编辑字段</div>}
            </>
          ) : (
            <>
              <div className="text-[12px] font-semibold text-pi-text">{cur.title || cur.file}</div>
              <div className="text-[10px] font-mono text-pi-dim2">{cur.layout || '—'} · {cur.file}</div>
              <div className="text-[11px] text-pi-dim2 leading-relaxed pt-1">改文案会保留这套设计，只替换文字；更大的改动用下方 AI 修改。</div>
            </>
          )}
          {/* AI 辅助改页：对话式单页重设计 */}
          <div className="pt-2 border-t border-pi-border-soft/60 space-y-1.5">
            <div className="text-[11px] font-semibold text-pi-dim">🤖 AI 修改本页</div>
            <textarea className="input-pi !py-1.5 text-[12px] w-full resize-none" rows={2}
              placeholder="如：这页改成左右对比版式；标题换成…；加一张数据卡；语气更犀利些…"
              value={refineInstr} onChange={e => setRefineInstr(e.target.value)} />
            <button className="btn-primary text-xs w-full !py-1.5 disabled:opacity-50" disabled={refining || !refineInstr.trim() || !dir} onClick={doRefine}>
              {refining ? '改写中…（1-3 分钟）' : '提交修改'}
            </button>
            {refineMsg && <div className={`text-[10px] leading-relaxed ${refineMsg.startsWith('✓') ? 'text-emerald-500' : refineMsg.startsWith('✗') ? 'text-red-400' : 'text-pi-dim2'}`}>{refineMsg}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
