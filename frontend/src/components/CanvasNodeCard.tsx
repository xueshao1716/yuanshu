import { Trash2, Wand2, Link2, Loader2, ImageOff } from 'lucide-react'
import type { CanvasNode } from '../types'
import { NODE_KINDS } from '../lib/canvas-nodes.mjs'
import PanoramaViewer from './PanoramaViewer'

// ── 画布节点卡片（复刻可乐 AI 画布）──
// 三种节点：提示词（输出 prompt）/ 配置（输出 provider+modelId+size）/ 图片（吃 prompt+config 出图）。
// 派生值（继承来的提示词与配置）由父层用纯逻辑算好传进来，卡片本身不做推导，方便单测。

const SIZE_OPTIONS = ['1024x1024', '832x1472', '1472x832', '2048x1024']
const SIZE_LABEL: Record<string, string> = {
  '1024x1024': '方形 1:1', '832x1472': '竖版 9:16', '1472x832': '横版 16:9', '2048x1024': '全景 2:1',
}

export type CardDerived = {
  prompt: { text: string; sourceId: string | null; inherited: boolean }
  config: { provider: string; modelId: string; model: string; size: string; template: string; sourceId: string | null }
}

export default function CanvasNodeCard({
  node, selected, degraded, derived, busy, ready, imageModels, modelKey, onSelect, onPatch,
  onHeaderPointerDown, onStartLink, onDelete, onGenerate,
}: {
  node: CanvasNode
  selected: boolean
  degraded: boolean
  derived: CardDerived
  busy: boolean
  ready: { ok: boolean; reason: string }
  imageModels: { id: string; provider: string; name: string; free?: boolean }[]
  modelKey: (m: { id: string; provider: string }) => string
  onSelect: () => void
  onPatch: (patch: Partial<CanvasNode>) => void
  onHeaderPointerDown: (e: React.PointerEvent) => void
  onStartLink: (e: React.PointerEvent) => void
  onDelete: () => void
  onGenerate: () => void
}) {
  const meta = NODE_KINDS[node.kind]
  const statusTint =
    node.status === 'error' ? 'border-pi-red/70' :
    node.status === 'running' ? 'border-pi-accent/70' :
    node.status === 'done' ? 'border-pi-success/50' :
    selected ? 'border-pi-accent' : 'border-pi-border-soft'
  const isPano = node.kind === 'image' && node.template === 'panorama'

  return (
    <div
      data-node-id={node.id}
      className={`absolute panel !p-0 flex flex-col overflow-hidden border ${statusTint} ${selected ? 'ring-2 ring-pi-accent/40' : ''} ${degraded ? 'opacity-95' : ''}`}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      onPointerDown={e => { e.stopPropagation(); onSelect() }}
    >
      {/* 头部：拖动整卡 */}
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 border-b border-pi-border-soft bg-pi-bg2/60 cursor-grab active:cursor-grabbing select-none"
        onPointerDown={onHeaderPointerDown}
      >
        <span className="text-[11px] font-semibold text-pi-text truncate">{node.title || meta.label}</span>
        <span className="text-[10px] text-pi-dim2 px-1 rounded-pi-pill bg-pi-bg2 border border-pi-border-soft shrink-0">{meta.label}</span>
        {node.status === 'running' && <Loader2 className="w-3 h-3 text-pi-accent animate-spin shrink-0" />}
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <button className="btn-tool !px-1.5 !min-h-0 !py-0.5" title="删除节点" onClick={e => { e.stopPropagation(); onDelete() }}>
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* 输入锚点（图片节点） */}
      {meta.inputs.length > 0 && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 flex flex-col gap-1.5">
          {meta.inputs.map(k => (
            <span key={k} title={`接收 ${k === 'prompt' ? '提示词' : '配置'}`}
              className="w-2.5 h-2.5 rounded-full bg-pi-bg border-2 border-pi-dim2" />
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden p-2 space-y-2">
        {node.kind === 'prompt' && (
          <>
            <textarea
              className="input-pi text-[12px] resize-none min-h-0 h-full"
              placeholder="写提示词… 连到图片节点即可出图"
              value={node.text}
              onChange={e => onPatch({ text: e.target.value })}
              onPointerDown={e => e.stopPropagation()}
            />
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-pi-dim2">模板</span>
              {(['plain', 'panorama'] as const).map(t => (
                <button key={t}
                  className={`px-1.5 py-0.5 rounded-pi-pill text-[10px] border transition-colors ${node.template === t ? 'bg-pi-accent/15 border-pi-accent/50 text-pi-accent' : 'border-pi-border-soft text-pi-dim2 hover:text-pi-text'}`}
                  onClick={() => onPatch({ template: t })}>
                  {t === 'plain' ? '原样' : '全景'}
                </button>
              ))}
            </div>
          </>
        )}

        {node.kind === 'config' && (
          <>
            <select aria-label="出图模型" className="input-pi !min-h-0 !py-1 text-[11px]" value={modelKey({ id: node.modelId, provider: node.provider })}
              onChange={e => {
                const m = imageModels.find(x => modelKey(x) === e.target.value)
                if (m) onPatch({ provider: m.provider, modelId: m.id, model: `${m.name}（${m.provider}）` })
              }}
              onPointerDown={e => e.stopPropagation()}>
              {!node.modelId && <option value="">选择出图模型…</option>}
              {imageModels.map(m => (
                <option key={modelKey(m)} value={modelKey(m)}>{m.name}（{m.provider}）{m.free ? ' · 免费' : ''}</option>
              ))}
            </select>
            <select aria-label="尺寸" className="input-pi !min-h-0 !py-1 text-[11px]" value={node.size}
              onChange={e => onPatch({ size: e.target.value })} onPointerDown={e => e.stopPropagation()}>
              <option value="">跟随默认</option>
              {SIZE_OPTIONS.map(s => <option key={s} value={s}>{SIZE_LABEL[s] ?? s}</option>)}
            </select>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-pi-dim2">模板</span>
              {(['plain', 'panorama'] as const).map(t => (
                <button key={t}
                  className={`px-1.5 py-0.5 rounded-pi-pill text-[10px] border transition-colors ${node.template === t ? 'bg-pi-accent/15 border-pi-accent/50 text-pi-accent' : 'border-pi-border-soft text-pi-dim2 hover:text-pi-text'}`}
                  onClick={() => onPatch({ template: t })}>
                  {t === 'plain' ? '原样' : '全景'}
                </button>
              ))}
            </div>
          </>
        )}

        {node.kind === 'image' && (
          <>
            {node.url ? (
              isPano ? (
                <PanoramaViewer url={node.url} mode={degraded ? 'backdrop' : 'equirect'} className="flex-1 min-h-0 rounded-pi-sm border border-pi-border-soft" />
              ) : (
                <img src={node.url} alt={node.title} className="flex-1 min-h-0 w-full object-cover rounded-pi-sm border border-pi-border-soft" draggable={false} />
              )
            ) : (
              <div className="flex-1 min-h-0 rounded-pi-sm border border-dashed border-pi-border-soft flex flex-col items-center justify-center gap-1 text-pi-dim2">
                <ImageOff className="w-5 h-5" />
                <span className="text-[10px]">还没有图</span>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <button className="btn-primary !text-[11px] !px-2 !min-h-0 !py-1 flex-1 disabled:opacity-50"
                disabled={busy || !ready.ok}
                title={ready.ok ? '生成' : ready.reason}
                onClick={e => { e.stopPropagation(); onGenerate() }}
                onPointerDown={e => e.stopPropagation()}>
                {busy ? <><Loader2 className="w-3 h-3 animate-spin inline mr-1" />生成中</> : <><Wand2 className="w-3 h-3 inline mr-1" />生成</>}
              </button>
            </div>
            {!ready.ok && node.status !== 'running' && <div className="text-[10px] text-pi-dim2 leading-snug">{ready.reason}</div>}
            {node.error && <div className="text-[10px] text-pi-red leading-snug break-all">{node.error}</div>}
            <input className="input-pi !min-h-0 !py-1 text-[11px]" placeholder="参考图 URL（可选，图生全景）"
              value={node.ref} onChange={e => onPatch({ ref: e.target.value })} onPointerDown={e => e.stopPropagation()} />
          </>
        )}
      </div>

      {/* 输出锚点 */}
      {meta.outputs.length > 0 && (
        <button
          title="拖到图片节点上连线"
          className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-4 h-4 rounded-full bg-pi-bg border-2 border-pi-accent hover:scale-110 transition-transform cursor-crosshair"
          onPointerDown={e => { e.stopPropagation(); onStartLink(e) }}
          onClick={e => e.stopPropagation()}
        >
          <Link2 className="w-2 h-2 text-pi-accent mx-auto" />
        </button>
      )}
    </div>
  )
}
