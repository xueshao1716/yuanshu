import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PenLine as PromptIcon, Sliders, Image as ImageIcon, Download, Upload, Trash2,
  ZoomIn, ZoomOut, Maximize, Crosshair, Loader2, Link2, Unlink, Wand2,
} from 'lucide-react'
import PageHeader from '../components/PageHeader'
import CanvasNodeCard from '../components/CanvasNodeCard'
import type { CanvasNode, CanvasEdge, CanvasView, Model } from '../types'
import { MediaApi } from '../api'
import { useApp } from '../store'
import { useMediaModel } from '../hooks/useMediaModel'
import {
  CANVAS_LIMITS, NODE_KINDS, createNode, addEdge, removeEdge, incoming,
  resolvePrompt, resolveConfig, imageReady, imageRequest, nodeSizeFor,
  RenderGuard, selectRenderable, clampZoom, screenToWorld, worldToScreen, zoomAt,
  nextPosition, serializeCanvas, parseCanvas,
} from '../lib/canvas-nodes.mjs'

const STORAGE_KEY = 'pi-canvas-doc-v1'
const GRID = 32

type Doc = { nodes: CanvasNode[]; edges: CanvasEdge[]; view: CanvasView }

const EMPTY: Doc = { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } }

function loadDoc(): Doc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const r = parseCanvas(raw)
    return r.ok && r.doc ? (r.doc as Doc) : EMPTY
  } catch { return EMPTY }
}

export default function Canvas({ models: modelsProp, bare }: { models?: Model[]; bare?: boolean } = {}) {
  const { models: appModels } = useApp()
  const models = modelsProp ?? appModels
  const { choices: imageModels, modelKey } = useMediaModel(models, 'image')
  const [doc, setDoc] = useState<Doc>(loadDoc)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [gen, setGen] = useState<{ id: string; startedAt: number } | null>(null)
  const [toast, setToast] = useState('')
  const [renderSet, setRenderSet] = useState<Set<string> | null>(null)
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const guardRef = useRef(new RenderGuard(CANVAS_LIMITS.render))
  const dragRef = useRef<{ mode: 'pan' | 'node'; id?: string; sx: number; sy: number; wx: number; wy: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const genRef = useRef(gen)
  genRef.current = gen

  const { nodes, edges, view } = doc
  const say = useCallback((t: string) => { setToast(t); window.setTimeout(() => setToast(''), 2600) }, [])

  // 持久化
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, serializeCanvas(doc)) } catch { /* 隐私模式/超额，静默 */ }
  }, [doc])

  // 渲染守卫：只对「视口内可见」的候选做 LRU，超出上限的降级为占位卡片
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const run = () => {
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const v = doc.view
      const visible = nodes.filter(n => {
        const a = worldToScreen({ x: n.x, y: n.y }, v)
        const b = worldToScreen({ x: n.x + n.w, y: n.y + n.h }, v)
        return b.x > -80 && a.x < rect.width + 80 && b.y > -80 && a.y < rect.height + 80
      }).map(n => n.id)
      const { render } = selectRenderable(visible, guardRef.current)
      setRenderSet(new Set(render))
    }
    run()
    const ro = new ResizeObserver(run)
    ro.observe(el)
    return () => ro.disconnect()
  }, [nodes, doc.view])

  // ── 指针交互：平移 / 拖节点 / 拉连线 ──
  const stagePoint = (e: { clientX: number; clientY: number }) => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return { sx: 0, sy: 0 }
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top }
  }

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    const { sx, sy } = stagePoint(e)
    // 落在节点上：交给卡片自己的回调（卡片对 pointerdown 做了 stopPropagation）
    if ((e.target as HTMLElement).closest('[data-node-id]')) return
    if (linkFrom) { setLinkFrom(null); setPointer(null); return }
    setSelectedId(null)
    dragRef.current = { mode: 'pan', sx, sy, wx: view.x, wy: view.y }
    stageRef.current?.setPointerCapture(e.pointerId)
  }

  const onHeaderPointerDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelectedId(id)
    const n = nodes.find(x => x.id === id)
    if (!n) return
    const { sx, sy } = stagePoint(e)
    const w = screenToWorld({ x: sx, y: sy }, view)
    dragRef.current = { mode: 'node', id, sx, sy, wx: w.x - n.x, wy: w.y - n.y }
    stageRef.current?.setPointerCapture(e.pointerId)
  }

  const onStartLink = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelectedId(id)
    setLinkFrom(id)
    const { sx, sy } = stagePoint(e)
    setPointer(screenToWorld({ x: sx, y: sy }, view))
    stageRef.current?.setPointerCapture(e.pointerId)
  }

  const onStagePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    const { sx, sy } = stagePoint(e)
    if (linkFrom) setPointer(screenToWorld({ x: sx, y: sy }, view))
    if (!d) return
    if (d.mode === 'pan') {
      setDoc(cur => ({ ...cur, view: { ...cur.view, x: d.wx + (sx - d.sx), y: d.wy + (sy - d.sy) } }))
      return
    }
    const w = screenToWorld({ x: sx, y: sy }, view)
    setDoc(cur => ({
      ...cur,
      nodes: cur.nodes.map(n => n.id === d.id
        ? { ...n, x: Math.round(w.x - d.wx), y: Math.round(w.y - d.wy) }
        : n),
    }))
  }

  const onStagePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (stageRef.current?.hasPointerCapture?.(e.pointerId)) {
      stageRef.current.releasePointerCapture(e.pointerId)
    }
    if (!d && !linkFrom) return
    // 松手在哪个节点上 → 落地连线。
    // 注意：setPointerCapture 之后 e.target 会永远是 stage，命中测试必须用 elementFromPoint。
    if (linkFrom) {
      const host = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node-id]') as HTMLElement | null
      const toId = host?.dataset.nodeId
      if (toId && toId !== linkFrom) {
        setDoc(cur => {
          const from = cur.nodes.find(n => n.id === linkFrom)
          const to = cur.nodes.find(n => n.id === toId)
          if (!from || !to) return cur
          const r = addEdge(cur.edges, from, to)
          if (!r.ok) { say(r.reason); return cur }
          return { ...cur, edges: r.edges }
        })
      }
      setLinkFrom(null)
      setPointer(null)
    }
  }

  // 滚轮缩放（原生绑定，React 的 onWheel 是被动监听，preventDefault 会告警）
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      setDoc(cur => ({ ...cur, view: zoomAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, cur.view, factor) }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── 文档操作 ──
  const patchNode = useCallback((id: string, patch: Partial<CanvasNode>) => {
    setDoc(cur => ({ ...cur, nodes: cur.nodes.map(n => (n.id === id ? { ...n, ...patch } : n)) }))
  }, [])

  const addNode = (kind: CanvasNode['kind']) => {
    setDoc(cur => {
      const template = kind === 'image' ? 'panorama' : 'plain'
      const size = nodeSizeFor(kind, template)
      const pos = nextPosition(cur.nodes, kind, size)
      const n = createNode(kind, {
        ...pos, ...size, template,
        title: NODE_KINDS[kind].label,
        text: kind === 'image' ? '' : '',
      })
      setSelectedId(n.id)
      return { ...cur, nodes: [...cur.nodes, n] }
    })
  }

  const delNode = (id: string) => {
    setDoc(cur => ({
      ...cur,
      nodes: cur.nodes.filter(n => n.id !== id),
      edges: cur.edges.filter(e => e.from !== id && e.to !== id),
    }))
    setSelectedId(s => (s === id ? null : s))
  }

  const unlink = (fromId: string, toId: string) => {
    setDoc(cur => {
      const edge = cur.edges.find(e => e.from === fromId && e.to === toId)
      if (!edge) return cur
      return { ...cur, edges: removeEdge(cur.edges, edge.id) }
    })
  }

  const zoomBy = (factor: number) => {
    const el = stageRef.current
    const rect = el?.getBoundingClientRect()
    const center = { x: (rect?.width ?? 800) / 2, y: (rect?.height ?? 600) / 2 }
    setDoc(cur => ({ ...cur, view: zoomAt(center, cur.view, factor) }))
  }

  const resetView = () => setDoc(cur => ({ ...cur, view: { x: 0, y: 0, z: 1 } }))

  const clearDoc = () => {
    if (!nodes.length) return
    if (!window.confirm(`清空画布？将删除 ${nodes.length} 个节点，此操作不可撤销。`)) return
    guardRef.current = new RenderGuard(CANVAS_LIMITS.render)
    setSelectedId(null)
    setDoc(EMPTY)
    say('画布已清空')
  }

  const exportDoc = () => {
    const blob = new Blob([serializeCanvas(doc)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `canvas-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    say('已导出画布 JSON')
  }

  const importDoc = async (file: File) => {
    const r = parseCanvas(await file.text())
    if (!r.ok || !r.doc) { say(`导入失败：${r.errors.join('；') || '文件里没有节点'}`); return }
    guardRef.current = new RenderGuard(CANVAS_LIMITS.render)
    setDoc(r.doc as Doc)
    setSelectedId(null)
    say(r.errors.length ? `已导入，跳过 ${r.errors.length} 处无效内容` : '导入完成')
  }

  // ── 出图 ──
  const generate = async (id: string) => {
    if (genRef.current) { say('已有生成任务在进行，等它完成'); return }
    const node = nodes.find(n => n.id === id)
    if (!node) return
    const ready = imageReady(node, nodes, edges)
    if (!ready.ok) { patchNode(id, { error: ready.reason }); say(ready.reason); return }
    const body = imageRequest(node, nodes, edges)
    setGen({ id, startedAt: Date.now() })
    patchNode(id, { status: 'running', error: '' })
    try {
      const r = await MediaApi.image(body)
      if (r?.image) {
        patchNode(id, { status: 'done', url: r.image, error: '' })
        say('出图完成')
      } else {
        patchNode(id, { status: 'error', error: r?.error || '接口没有返回图片' })
        say('出图失败：' + (r?.error || '接口没有返回图片'))
      }
    } catch (e) {
      patchNode(id, { status: 'error', error: String(e) })
      say('出图失败：' + String(e))
    } finally {
      setGen(null)
    }
  }

  const selected = selectedId ? nodes.find(n => n.id === selectedId) ?? null : null
  const selDerived = useMemo(() => (selected ? {
    prompt: resolvePrompt(selected, nodes, edges),
    config: resolveConfig(selected, nodes, edges),
  } : null), [selected, nodes, edges])
  const selReady = useMemo(() => (selected && selected.kind === 'image' ? imageReady(selected, nodes, edges) : { ok: false, reason: '' }), [selected, nodes, edges])
  const selIncoming = useMemo(() => (selected ? incoming(selected.id, edges) : []), [selected, edges])

  const zoomPct = Math.round(clampZoom(view.z) * 100)

  return (
    <div className={`flex-1 min-h-0 flex flex-col ${bare ? '' : 'page-enter'}`}>
      {!bare && (
        <div className="px-3 sm:px-6 pt-4 sm:pt-6 pb-3">
          <PageHeader title="无限画布" description="提示词 · 配置 · 图片三种节点连成流水线，全景图按 2:1 等距柱状投影硬约束生成" />
        </div>
      )}

      {/* 工具栏 */}
      <div className={`flex-none pb-3 flex flex-wrap items-center gap-1.5 ${bare ? 'px-3 sm:px-6' : 'px-3 sm:px-6'}`}>
        <div className="flex items-center gap-1 mr-1">
          <button className="btn-tool !min-h-11 sm:!min-h-9" title="添加文本节点" onClick={() => addNode('text')}>
            <Type className="w-3.5 h-3.5" /><span className="hidden sm:inline">文本</span>
          </button>
          <button className="btn-tool !min-h-11 sm:!min-h-9" title="添加提示词节点" onClick={() => addNode('prompt')}>
            <PromptIcon className="w-3.5 h-3.5" /><span className="hidden sm:inline">提示词</span>
          </button>
          <button className="btn-tool !min-h-11 sm:!min-h-9" title="添加配置节点" onClick={() => addNode('config')}>
            <Sliders className="w-3.5 h-3.5" /><span className="hidden sm:inline">配置</span>
          </button>
          <button className="btn-tool !min-h-11 sm:!min-h-9" title="添加图片节点" onClick={() => addNode('image')}>
            <ImageIcon className="w-3.5 h-3.5" /><span className="hidden sm:inline">图片</span>
          </button>
        </div>
        <div className="w-px h-6 bg-pi-border-soft mx-0.5" />
        <button className="btn-tool !min-h-11 sm:!min-h-9" title="导入 JSON" onClick={() => fileRef.current?.click()}>
          <Upload className="w-3.5 h-3.5" />
        </button>
        <button className="btn-tool !min-h-11 sm:!min-h-9" title="导出 JSON" onClick={exportDoc} disabled={!nodes.length}>
          <Download className="w-3.5 h-3.5" />
        </button>
        <button className="btn-tool !min-h-11 sm:!min-h-9" title="清空画布" onClick={clearDoc} disabled={!nodes.length}>
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <div className="w-px h-6 bg-pi-border-soft mx-0.5" />
        <button className="btn-tool !min-h-11 sm:!min-h-9" title="缩小" onClick={() => zoomBy(1 / 1.2)}>
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="text-[11px] text-pi-dim2 w-10 text-center tabular-nums">{zoomPct}%</span>
        <button className="btn-tool !min-h-11 sm:!min-h-9" title="放大" onClick={() => zoomBy(1.2)}>
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button className="btn-tool !min-h-11 sm:!min-h-9" title="复位视图" onClick={resetView}>
          <Maximize className="w-3.5 h-3.5" />
        </button>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-pi-dim2">
          {gen && <span className="flex items-center gap-1 text-pi-accent"><Loader2 className="w-3 h-3 animate-spin" />生成中…</span>}
          <span>{nodes.length} 节点 · {edges.length} 连线</span>
        </div>
      </div>

      {/* 舞台 + 检查器 */}
      <div className={`flex-1 min-h-0 flex gap-3 ${bare ? 'px-3 sm:px-6 pb-3 sm:pb-4' : 'px-3 sm:px-6 pb-3 sm:pb-6'}`}>
        <div
          ref={stageRef}
          data-testid="canvas-stage"
          className={`relative flex-1 min-h-0 min-w-0 overflow-hidden rounded-pi-lg border border-pi-border-soft bg-pi-bg1 ${linkFrom ? 'cursor-crosshair' : ''}`}
          style={{
            backgroundImage: 'radial-gradient(circle, var(--pi-border) 1px, transparent 1px)',
            backgroundSize: `${GRID * view.z}px ${GRID * view.z}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
            touchAction: 'none',
          }}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onPointerCancel={onStagePointerUp}
        >
          <div className="absolute inset-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
            {/* 连线层 */}
            <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" style={{ width: 1, height: 1 }}>
              <defs>
                <marker id="canvas-arrow" viewBox="0 0 8 8" refX="6" refY="4"
                  markerWidth={8 / view.z} markerHeight={8 / view.z} markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--pi-accent)" />
                </marker>
              </defs>
              {edges.map(e => {
                const a = nodes.find(n => n.id === e.from)
                const b = nodes.find(n => n.id === e.to)
                if (!a || !b) return null
                const x1 = a.x + a.w, y1 = a.y + a.h / 2
                const x2 = b.x, y2 = b.y + b.h / 2
                const dx = Math.max(60, Math.abs(x2 - x1) * 0.5)
                return (
                  <path key={e.id}
                    d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                    fill="none" stroke="var(--pi-accent)" strokeWidth={2 / view.z} opacity={0.75}
                    markerEnd="url(#canvas-arrow)" />
                )
              })}
              {linkFrom && pointer && (() => {
                const a = nodes.find(n => n.id === linkFrom)
                if (!a) return null
                const x1 = a.x + a.w, y1 = a.y + a.h / 2
                const dx = Math.max(60, Math.abs(pointer.x - x1) * 0.5)
                return <path d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${pointer.x - dx} ${pointer.y}, ${pointer.x} ${pointer.y}`}
                  fill="none" stroke="var(--pi-accent)" strokeWidth={2 / view.z} strokeDasharray={`${6 / view.z} ${4 / view.z}`} opacity={0.9} />
              })()}
            </svg>

            {/* 节点层 */}
            {nodes.map(n => {
              const derived = {
                prompt: resolvePrompt(n, nodes, edges),
                config: resolveConfig(n, nodes, edges),
              }
              const ready = n.kind === 'image' ? imageReady(n, nodes, edges) : { ok: false, reason: '' }
              return (
                <CanvasNodeCard
                  key={n.id}
                  node={n}
                  selected={n.id === selectedId}
                  degraded={renderSet !== null && !renderSet.has(n.id)}
                  derived={derived}
                  busy={gen?.id === n.id}
                  ready={ready}
                  imageModels={imageModels}
                  modelKey={modelKey}
                  onSelect={() => setSelectedId(n.id)}
                  onPatch={p => patchNode(n.id, p)}
                  onHeaderPointerDown={onHeaderPointerDown(n.id)}
                  onStartLink={onStartLink(n.id)}
                  onDelete={() => delNode(n.id)}
                  onGenerate={() => generate(n.id)}
                />
              )
            })}
          </div>

          {/* 空状态 */}
          {nodes.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-pi-dim2 pointer-events-none">
              <Crosshair className="w-8 h-8 opacity-50" />
              <div className="text-sm">画布是空的</div>
              <div className="text-[11px]">从上方加一个「提示词」和一个「配置」节点，连到「图片」节点上就能出图</div>
            </div>
          )}

          {/* 连线模式提示 */}
          {linkFrom && (
            <div className="absolute left-1/2 -translate-x-1/2 top-3 px-3 py-1.5 rounded-pi-pill bg-pi-accent text-pi-on-accent text-[11px] shadow-lg flex items-center gap-1.5 pointer-events-none">
              <Link2 className="w-3 h-3" />拖到图片节点上松手即连线，点空白处取消
            </div>
          )}
        </div>

        {/* 检查器 */}
        <aside className="hidden lg:flex w-72 shrink-0 flex-col gap-3 overflow-y-auto">
          {!selected && (
            <div className="panel !p-3 text-[11px] text-pi-dim2 leading-relaxed">
              <div className="text-xs font-semibold text-pi-text mb-1.5">怎么用</div>
              <ul className="space-y-1 list-disc pl-3.5">
                <li>提示词节点写文案，拖右侧圆点连到图片节点</li>
                <li>配置节点选模型/尺寸/模板，同样连到图片节点</li>
                <li>图片节点默认全景模板，注入 2:1 等距柱状硬约束</li>
                <li>同一图片节点的提示词输入只保留最新一条</li>
                <li>滚轮以指针为中心缩放，拖空白处平移</li>
              </ul>
            </div>
          )}
          {selected && selDerived && (
            <div className="panel !p-3 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-pi-text truncate">{selected.title || NODE_KINDS[selected.kind].label}</span>
                <span className="text-[10px] text-pi-dim2 px-1.5 rounded-pi-pill bg-pi-bg2 border border-pi-border-soft shrink-0">{NODE_KINDS[selected.kind].label}</span>
                <button className="btn-tool !px-1.5 !min-h-0 !py-0.5 ml-auto" title="删除节点" onClick={() => delNode(selected.id)}>
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>

              <label className="block">
                <span className="text-[10px] text-pi-dim2">标题</span>
                <input className="input-pi !min-h-0 !py-1 text-[11px] mt-0.5" value={selected.title}
                  onChange={e => patchNode(selected.id, { title: e.target.value })} />
              </label>

              {selected.kind !== 'image' && (
                <label className="block">
                  <span className="text-[10px] text-pi-dim2">{selected.kind === 'prompt' ? '提示词正文' : '展示名（可选）'}</span>
                  {selected.kind === 'prompt' ? (
                    <textarea className="input-pi text-[11px] resize-none h-24 mt-0.5" value={selected.text}
                      onChange={e => patchNode(selected.id, { text: e.target.value })} />
                  ) : (
                    <input className="input-pi !min-h-0 !py-1 text-[11px] mt-0.5" value={selected.model}
                      onChange={e => patchNode(selected.id, { model: e.target.value })} />
                  )}
                </label>
              )}

              {selected.kind === 'image' && (
                <>
                  <div className="rounded-pi-sm border border-pi-border-soft p-2 space-y-1">
                    <div className="text-[10px] text-pi-dim2">实际送入 /api/image 的提示词</div>
                    <div className="text-[11px] text-pi-text leading-snug max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
                      {selDerived.prompt.text || '（空）'}
                    </div>
                    <div className="text-[10px] text-pi-dim2">
                      {selDerived.prompt.inherited ? `继承自上游提示词节点` : '来自本节点输入'}
                      {' · '}{selDerived.config.template === 'panorama' ? '全景模板已注入' : '原样模板'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button className="btn-primary !text-[11px] !px-2 !min-h-0 !py-1 flex-1 disabled:opacity-50"
                      disabled={gen !== null || !selReady.ok}
                      title={selReady.ok ? '生成' : selReady.reason}
                      onClick={() => generate(selected.id)}>
                      {gen?.id === selected.id ? <><Loader2 className="w-3 h-3 animate-spin inline mr-1" />生成中</> : <><Wand2 className="w-3 h-3 inline mr-1" />生成</>}
                    </button>
                    {selected.url && (
                      <a className="btn-tool !min-h-0 !py-1 !px-2 !text-[11px]" href={selected.url} target="_blank" rel="noreferrer">打开原图</a>
                    )}
                  </div>
                  {!selReady.ok && selected.status !== 'running' && <div className="text-[10px] text-pi-dim2 leading-snug">{selReady.reason}</div>}
                  {selected.error && <div className="text-[10px] text-pi-red leading-snug break-all">{selected.error}</div>}
                </>
              )}

              {selIncoming.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] text-pi-dim2">上游连线</div>
                  {selIncoming.map(e => {
                    const from = nodes.find(n => n.id === e.from)
                    return (
                      <div key={e.id} className="flex items-center gap-1.5 text-[11px]">
                        <span className="text-pi-dim2">{e.kind === 'prompt' ? '提示词' : '配置'}</span>
                        <span className="text-pi-text truncate flex-1">{from?.title || e.from}</span>
                        <button className="btn-tool !px-1 !min-h-0 !py-0.5" title="删除这条连线"
                          onClick={() => unlink(e.from, e.to)}>
                          <Unlink className="w-3 h-3" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-3 py-2 rounded-pi-md bg-pi-bg2 border border-pi-border-soft text-[12px] text-pi-text shadow-lg max-w-[90vw]" role="status">
          {toast}
        </div>
      )}
      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) void importDoc(f); e.target.value = '' }} />
    </div>
  )
}
