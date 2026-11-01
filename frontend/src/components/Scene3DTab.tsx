import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Download, Image as ImageIcon, Plus, Redo2, Save, Trash2, Undo2, Wand2, RotateCw } from 'lucide-react'
import { api } from '../api'

// ── 创作台 · 3D 空间 v2（2026-11-01）──
// 真编辑：选中/拖动/缩放/旋转/撤销、贴墙吸附、家具预设（多盒体拼装）、
// three.js 阴影渲染、第一人称漫游、导出单文件 HTML 与平面图 PNG、分房间造价。

type Room = { id: string; name: string; x: number; z: number; w: number; d: number; h: number; color: string }
type Item = { id: string; kind: string; x: number; z: number; w: number; d: number; h: number; rot: number; color: string }
type Plan = { name: string; rooms: Room[]; items: Item[] }
type Sel = { type: 'room' | 'item'; id: string } | null

const PX = 44
const GRID = 0.1
const ROOM_COLORS = ['#e8e2d8', '#ded6c8', '#dbe3e0', '#e6dfe9', '#e9e2cf']
const PRESETS: { kind: string; label: string; w: number; d: number; h: number; color: string }[] = [
  { kind: 'sofa', label: '沙发', w: 2.2, d: 0.9, h: 0.8, color: '#8a6b52' },
  { kind: 'bed', label: '床', w: 1.8, d: 2.0, h: 0.6, color: '#b9b2a6' },
  { kind: 'table', label: '桌子', w: 1.4, d: 0.8, h: 0.75, color: '#9a7b4f' },
  { kind: 'chair', label: '椅子', w: 0.5, d: 0.5, h: 0.9, color: '#7d6a55' },
  { kind: 'cabinet', label: '柜子', w: 1.2, d: 0.45, h: 2.0, color: '#8e8577' },
  { kind: 'rug', label: '地毯', w: 2.4, d: 1.6, h: 0.02, color: '#a89484' },
  { kind: 'plant', label: '绿植', w: 0.5, d: 0.5, h: 1.1, color: '#4c6b4a' },
  { kind: 'door', label: '门', w: 0.9, d: 0.1, h: 2.0, color: '#6f5a45' },
  { kind: 'window', label: '窗', w: 1.4, d: 0.1, h: 1.2, color: '#9fc6d8' },
]

const uid = () => Math.random().toString(36).slice(2, 8)
const snap = (v: number, step = GRID) => Math.round(v / step) * step
const round2 = (v: number) => Math.round(v * 100) / 100

export default function Scene3DTab() {
  const [plan, setPlan] = useState<Plan>({ name: '我的空间', rooms: [], items: [] })
  const [sel, setSel] = useState<Sel>(null)
  const [mode, setMode] = useState<'room' | 'place'>('room')
  const [placing, setPlacing] = useState<string>('sofa')
  const [price, setPrice] = useState('3000')
  const [msg, setMsg] = useState('')
  const [fp, setFp] = useState(false)
  const history = useRef<Plan[]>([])
  const future = useRef<Plan[]>([])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<any>(null)
  const plans = useSWR('scene3d-list', () => api<{ items: { name: string }[] }>('/api/scene3d/list'))

  const commit = useCallback((next: Plan) => {
    setPlan((prev) => { history.current.push(prev); if (history.current.length > 50) history.current.shift(); future.current = []; return next })
  }, [])
  const undo = () => {
    const prev = history.current.pop()
    if (!prev) return
    setPlan((cur) => { future.current.push(cur); return prev })
    setSel(null)
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next) return
    setPlan((cur) => { history.current.push(cur); return next })
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!sel) return
        e.preventDefault()
        commit({ ...plan, rooms: plan.rooms.filter((r) => !(sel.type === 'room' && r.id === sel.id)), items: plan.items.filter((i) => !(sel.type === 'item' && i.id === sel.id)) })
        setSel(null)
      }
      if (e.key.toLowerCase() === 'r' && sel?.type === 'item') {
        commit({ ...plan, items: plan.items.map((i) => (i.id === sel.id ? { ...i, rot: ((i.rot + 90) % 360) } : i)) })
      }
      const step = e.shiftKey ? 0.5 : 0.1
      const move = (dx: number, dz: number) => {
        if (!sel) return
        e.preventDefault()
        if (sel.type === 'room') commit({ ...plan, rooms: plan.rooms.map((r) => (r.id === sel.id ? { ...r, x: round2(r.x + dx), z: round2(r.z + dz) } : r)) })
        else commit({ ...plan, items: plan.items.map((i) => (i.id === sel.id ? { ...i, x: round2(i.x + dx), z: round2(i.z + dz) } : i)) })
      }
      if (e.key === 'ArrowLeft') move(-step, 0)
      if (e.key === 'ArrowRight') move(step, 0)
      if (e.key === 'ArrowUp') move(0, -step)
      if (e.key === 'ArrowDown') move(0, step)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [plan, sel, commit])

  const stats = useMemo(() => {
    const area = plan.rooms.reduce((a, r) => a + r.w * r.d, 0)
    const per = Number(price) || 0
    return { area: round2(area), cost: Math.round(area * per) }
  }, [plan.rooms, price])

  // ── 2D 绘制 ──
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = cv.clientWidth, h = cv.clientHeight
    cv.width = w * dpr; cv.height = h * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const toS = (x: number, z: number) => ({ X: x * PX, Y: z * PX })
    ctx.strokeStyle = 'rgba(140,150,165,0.12)'
    for (let i = 0; i * PX < w; i += 1) { ctx.beginPath(); ctx.moveTo(i * PX, 0); ctx.lineTo(i * PX, h); ctx.stroke() }
    for (let j = 0; j * PX < h; j += 1) { ctx.beginPath(); ctx.moveTo(0, j * PX); ctx.lineTo(w, j * PX); ctx.stroke() }
    for (const r of plan.rooms) {
      const p = toS(r.x, r.z)
      const active = sel?.type === 'room' && sel.id === r.id
      ctx.fillStyle = r.color; ctx.globalAlpha = active ? 0.75 : 0.5
      ctx.fillRect(p.X, p.Y, r.w * PX, r.d * PX); ctx.globalAlpha = 1
      ctx.strokeStyle = active ? '#2f81f7' : 'rgba(90,100,120,0.9)'; ctx.lineWidth = active ? 2.5 : 1.5
      ctx.strokeRect(p.X, p.Y, r.w * PX, r.d * PX)
      ctx.fillStyle = 'rgba(40,45,55,0.85)'; ctx.font = '11px system-ui'
      ctx.fillText(`${r.name} ${(r.w * r.d).toFixed(1)}㎡`, p.X + 6, p.Y + 15)
      if (active) { ctx.fillStyle = '#2f81f7'; ctx.fillRect(p.X + r.w * PX - 7, p.Y + r.d * PX - 7, 10, 10) }
    }
    for (const it of plan.items) {
      const p = toS(it.x, it.z)
      const w2 = (it.rot % 180 === 0 ? it.w : it.d) * PX
      const d2 = (it.rot % 180 === 0 ? it.d : it.w) * PX
      const active = sel?.type === 'item' && sel.id === it.id
      ctx.fillStyle = it.color; ctx.globalAlpha = it.kind === 'rug' ? 0.5 : 0.9
      ctx.fillRect(p.X, p.Y, w2, d2); ctx.globalAlpha = 1
      ctx.strokeStyle = active ? '#2f81f7' : 'rgba(40,45,55,0.7)'; ctx.lineWidth = active ? 2.5 : 1
      ctx.strokeRect(p.X, p.Y, w2, d2)
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = '9px system-ui'
      const label = PRESETS.find((x) => x.kind === it.kind)?.label || it.kind
      if (w2 > 26 && d2 > 16) ctx.fillText(label, p.X + 3, p.Y + 11)
    }
  }, [plan, sel])

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: (e.clientX - rect.left) / PX, z: (e.clientY - rect.top) / PX }
  }
  const hit = (x: number, z: number): Sel => {
    for (let i = plan.items.length - 1; i >= 0; i -= 1) {
      const it = plan.items[i]
      const w2 = it.rot % 180 === 0 ? it.w : it.d
      const d2 = it.rot % 180 === 0 ? it.d : it.w
      if (x >= it.x && x <= it.x + w2 && z >= it.z && z <= it.z + d2) return { type: 'item', id: it.id }
    }
    for (let i = plan.rooms.length - 1; i >= 0; i -= 1) {
      const r = plan.rooms[i]
      if (x >= r.x && x <= r.x + r.w && z >= r.z && z <= r.z + r.d) return { type: 'room', id: r.id }
    }
    return null
  }
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointAt(e)
    if (mode === 'place') {
      const preset = PRESETS.find((x) => x.kind === placing)!
      commit({ ...plan, items: [...plan.items, { id: uid(), kind: placing, x: snap(p.x), z: snap(p.z), w: preset.w, d: preset.d, h: preset.h, rot: 0, color: preset.color }] })
      return
    }
    const target = hit(p.x, p.z)
    setSel(target)
    if (!target) { dragRef.current = { kind: 'new', x0: p.x, z0: p.z }; return }
    if (target.type === 'room') {
      const r = plan.rooms.find((x) => x.id === target.id)!
      const onHandle = p.x > r.x + r.w - 0.35 && p.z > r.z + r.d - 0.35
      dragRef.current = { kind: onHandle ? 'resize' : 'move', type: 'room', id: target.id, x0: p.x, z0: p.z, orig: { ...r } }
    } else {
      const it = plan.items.find((x) => x.id === target.id)!
      dragRef.current = { kind: 'move', type: 'item', id: target.id, x0: p.x, z0: p.z, orig: { ...it } }
    }
  }
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d) return
    const p = pointAt(e)
    if (d.kind === 'new') return
    const dx = snap(p.x - d.x0), dz = snap(p.z - d.z0)
    if (d.type === 'room') {
      setPlan((prev) => ({
        ...prev,
        rooms: prev.rooms.map((r) => {
          if (r.id !== d.id) return r
          if (d.kind === 'resize') return { ...r, w: Math.max(0.5, snap(d.orig.w + dx)), d: Math.max(0.5, snap(d.orig.d + dz)) }
          const nx = Math.max(0, snap(d.orig.x + dx)), nz = Math.max(0, snap(d.orig.z + dz))
          return { ...r, x: nx, z: nz }
        }),
      }))
    } else {
      setPlan((prev) => ({
        ...prev,
        items: prev.items.map((i) => (i.id === d.id ? { ...i, x: Math.max(0, snap(d.orig.x + dx)), z: Math.max(0, snap(d.orig.z + dz)) } : i)),
      }))
    }
  }
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.kind === 'new') {
      const p = pointAt(e)
      const x = Math.min(snap(d.x0), snap(p.x)), z = Math.min(snap(d.z0), snap(p.z))
      const w = Math.max(0.5, snap(Math.abs(p.x - d.x0))), dd = Math.max(0.5, snap(Math.abs(p.z - d.z0)))
      if (w < 0.6 || dd < 0.6) return
      commit({ ...plan, rooms: [...plan.rooms, { id: uid(), name: `房间${plan.rooms.length + 1}`, x, z, w, d: dd, h: 2.8, color: ROOM_COLORS[plan.rooms.length % ROOM_COLORS.length] }] })
      return
    }
    // 拖动结束才进历史（否则每帧都进栈）
    commit(plan)
  }

  const updateSel = (patch: Partial<Room & Item>) => {
    if (!sel) return
    commit({
      ...plan,
      rooms: sel.type === 'room' ? plan.rooms.map((r) => (r.id === sel.id ? { ...r, ...patch } : r)) : plan.rooms,
      items: sel.type === 'item' ? plan.items.map((i) => (i.id === sel.id ? { ...i, ...patch } : i)) : plan.items,
    })
  }

  const save = async () => {
    const out: any = await api('/api/scene3d/save', { method: 'POST', body: { plan } }).catch((e: any) => ({ ok: false, error: e?.message }))
    setMsg(out?.ok ? `已保存：${out.name}` : `保存失败：${out?.error || '未知'}`)
    if (out?.ok) void plans.mutate()
  }
  const exportIt = async () => {
    const out: any = await api('/api/scene3d/export', { method: 'POST', body: { plan, pricePerSqm: Number(price) || 0 } }).catch((e: any) => ({ ok: false, error: e?.message }))
    setMsg(out?.ok ? `已导出：${out.file}（${(out.bytes / 1024).toFixed(0)} KB）` : `导出失败：${out?.error || '未知'}`)
  }
  const exportPng = () => {
    const cv = canvasRef.current
    if (!cv) return
    const a = document.createElement('a')
    a.href = cv.toDataURL('image/png')
    a.download = `${plan.name || '户型'}-平面图.png`
    a.click()
  }
  const load = async (name: string) => {
    const out: any = await api(`/api/scene3d/plan?name=${encodeURIComponent(name)}`).catch(() => null)
    if (out?.plan) { commit(out.plan); setMsg(`已载入：${name}`) }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,430px)_minmax(0,1fr)]">
      <section className="panel p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <input value={plan.name} onChange={(e) => setPlan((p) => ({ ...p, name: e.target.value }))}
            className="min-w-0 flex-1 rounded-pi-md border border-pi-border-soft bg-pi-bg2 px-2 py-1.5 text-[13px]" placeholder="空间名" />
          <button type="button" onClick={() => setMode('room')} className={`min-h-8 px-2 rounded-pi-md text-[12px] ${mode === 'room' ? 'bg-pi-accent text-pi-on-accent' : 'text-pi-dim'}`}>画房间</button>
          <button type="button" onClick={() => setMode('place')} className={`min-h-8 px-2 rounded-pi-md text-[12px] ${mode === 'place' ? 'bg-pi-accent text-pi-on-accent' : 'text-pi-dim'}`}>摆家具</button>
        </div>
        {mode === 'place' && (
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button key={p.kind} type="button" onClick={() => setPlacing(p.kind)}
                className={`text-[11px] min-h-7 px-2 rounded ${placing === p.kind ? 'bg-pi-accent text-pi-on-accent' : 'bg-pi-bg3 text-pi-dim'}`}>{p.label}</button>
            ))}
          </div>
        )}
        <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          className="w-full rounded-pi-md border border-pi-border-soft bg-pi-bg2 touch-none" style={{ height: 380 }} />
        <p className="text-[11px] text-pi-dim2">拖动移动 · 右下角小方块改尺寸 · R 旋转 · Delete 删除 · 方向键微调 · Ctrl+Z 撤销</p>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-pi-dim2">
          <span>面积 {stats.area} ㎡</span>
          <label className="flex items-center gap-1">单价¥<input value={price} onChange={(e) => setPrice(e.target.value)} className="w-16 rounded border border-pi-border-soft bg-pi-bg2 px-1 py-0.5" /></label>
          <span>估算 ¥{stats.cost.toLocaleString()}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={undo} title="撤销" className="inline-flex items-center gap-1 min-h-8 px-2 rounded-pi-md bg-pi-bg3 text-[12px]"><Undo2 className="w-3.5 h-3.5" />撤销</button>
          <button type="button" onClick={redo} title="重做" className="inline-flex items-center gap-1 min-h-8 px-2 rounded-pi-md bg-pi-bg3 text-[12px]"><Redo2 className="w-3.5 h-3.5" />重做</button>
          <button type="button" onClick={() => void save()} className="inline-flex items-center gap-1 min-h-8 px-2 rounded-pi-md bg-pi-bg3 text-[12px]"><Save className="w-3.5 h-3.5" />保存</button>
          <button type="button" onClick={() => void exportIt()} className="inline-flex items-center gap-1 min-h-8 px-2 rounded-pi-md bg-pi-bg3 text-[12px]"><Download className="w-3.5 h-3.5" />导出 HTML</button>
          <button type="button" onClick={exportPng} className="inline-flex items-center gap-1 min-h-8 px-2 rounded-pi-md bg-pi-bg3 text-[12px]"><ImageIcon className="w-3.5 h-3.5" />平面图 PNG</button>
          <button type="button" onClick={() => setFp((v) => !v)} className={`inline-flex items-center gap-1 min-h-8 px-2 rounded-pi-md text-[12px] ${fp ? 'bg-pi-accent text-pi-on-accent' : 'bg-pi-bg3'}`}><Wand2 className="w-3.5 h-3.5" />{fp ? '退出漫游' : '第一人称'}</button>
        </div>
        {sel && (
          <div className="rounded-pi-md border border-pi-border-soft p-2 space-y-1.5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-pi-text">{sel.type === 'room' ? '房间' : '家具'}</span>
              <button type="button" onClick={() => { setPlan((p) => ({ ...p, rooms: p.rooms.filter((r) => !(sel.type === 'room' && r.id === sel.id)), items: p.items.filter((i) => !(sel.type === 'item' && i.id === sel.id)) })); setSel(null) }}
                className="text-pi-red inline-flex items-center gap-1 text-[11px]"><Trash2 className="w-3 h-3" />删除</button>
            </div>
            {sel.type === 'room' ? (
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <label className="flex items-center gap-1">名<input value={(plan.rooms.find((r) => r.id === sel.id)?.name) || ''} onChange={(e) => updateSel({ name: e.target.value })} className="w-full rounded border border-pi-border-soft bg-pi-bg2 px-1 py-0.5" /></label>
                <label className="flex items-center gap-1">层高<input type="number" step="0.1" value={plan.rooms.find((r) => r.id === sel.id)?.h ?? 2.8} onChange={(e) => updateSel({ h: Number(e.target.value) })} className="w-full rounded border border-pi-border-soft bg-pi-bg2 px-1 py-0.5" /></label>
                <label className="flex items-center gap-1">宽<input type="number" step="0.1" value={plan.rooms.find((r) => r.id === sel.id)?.w ?? 4} onChange={(e) => updateSel({ w: Math.max(0.5, Number(e.target.value)) })} className="w-full rounded border border-pi-border-soft bg-pi-bg2 px-1 py-0.5" /></label>
                <label className="flex items-center gap-1">深<input type="number" step="0.1" value={plan.rooms.find((r) => r.id === sel.id)?.d ?? 3} onChange={(e) => updateSel({ d: Math.max(0.5, Number(e.target.value)) })} className="w-full rounded border border-pi-border-soft bg-pi-bg2 px-1 py-0.5" /></label>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <label className="flex items-center gap-1">宽<input type="number" step="0.1" value={plan.items.find((i) => i.id === sel.id)?.w ?? 1} onChange={(e) => updateSel({ w: Math.max(0.2, Number(e.target.value)) })} className="w-full rounded border border-pi-border-soft bg-pi-bg2 px-1 py-0.5" /></label>
                <label className="flex items-center gap-1">深<input type="number" step="0.1" value={plan.items.find((i) => i.id === sel.id)?.d ?? 1} onChange={(e) => updateSel({ d: Math.max(0.2, Number(e.target.value)) })} className="w-full rounded border border-pi-border-soft bg-pi-bg2 px-1 py-0.5" /></label>
                <label className="flex items-center gap-1">高<input type="number" step="0.1" value={plan.items.find((i) => i.id === sel.id)?.h ?? 1} onChange={(e) => updateSel({ h: Math.max(0.05, Number(e.target.value)) })} className="w-full rounded border border-pi-border-soft bg-pi-bg2 px-1 py-0.5" /></label>
                <button type="button" onClick={() => updateSel({ rot: ((plan.items.find((i) => i.id === sel.id)?.rot || 0) + 90) % 360 })} className="inline-flex items-center justify-center gap-1 rounded bg-pi-bg3 text-[11px]"><RotateCw className="w-3 h-3" />旋转 90°</button>
              </div>
            )}
          </div>
        )}
        {msg && <p className="text-[12px] text-pi-text break-all">{msg}</p>}
        {(plans.data?.items || []).length > 0 && (
          <div className="border-t border-pi-border-soft pt-2 flex flex-wrap gap-1">
            {(plans.data?.items || []).slice(0, 8).map((it) => (
              <button key={it.name} type="button" onClick={() => void load(it.name)} className="text-[11px] px-2 py-1 rounded bg-pi-bg3 text-pi-dim hover:text-pi-text">{it.name}</button>
            ))}
          </div>
        )}
      </section>
      <section className="panel p-0 overflow-hidden" style={{ minHeight: 520 }}>
        <Scene3DView plan={plan} selected={sel} firstPerson={fp} onExitFirstPerson={() => setFp(false)} />
      </section>
    </div>
  )
}

function Scene3DView({ plan, selected, firstPerson, onExitFirstPerson }: { plan: Plan; selected: Sel; firstPerson: boolean; onExitFirstPerson: () => void }) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<any>({ keys: {} })

  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#12161f')
    const camera = new THREE.PerspectiveCamera(60, el.clientWidth / Math.max(1, el.clientHeight), 0.05, 500)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.setSize(el.clientWidth, el.clientHeight)
    renderer.shadowMap.enabled = true
    el.appendChild(renderer.domElement)

    const rooms = plan.rooms.length ? plan.rooms : [{ id: 'p', name: '样板', x: 0, z: 0, w: 6, d: 4, h: 2.8, color: '#e8e2d8' }]
    const minX = Math.min(...rooms.map((r) => r.x)), maxX = Math.max(...rooms.map((r) => r.x + r.w))
    const minZ = Math.min(...rooms.map((r) => r.z)), maxZ = Math.max(...rooms.map((r) => r.z + r.d))
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
    const root = new THREE.Group()
    scene.add(root)

    for (const r of rooms) {
      const active = selected?.type === 'room' && selected.id === r.id
      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(r.w, 0.06, r.d),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(r.color), roughness: 0.95, emissive: active ? new THREE.Color('#1b3a5c') : new THREE.Color('#000000') }),
      )
      floor.position.set(r.x + r.w / 2 - cx, -0.03, r.z + r.d / 2 - cz)
      floor.receiveShadow = true
      root.add(floor)
      const h = r.h
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#cfc7b8'), roughness: 0.9, transparent: true, opacity: active ? 0.35 : 0.5 })
      const walls = [
        { w: r.w, d: 0.06, x: r.x + r.w / 2, z: r.z },
        { w: 0.06, d: r.d, x: r.x, z: r.z + r.d / 2 },
        { w: 0.06, d: r.d, x: r.x + r.w, z: r.z + r.d / 2 },
      ]
      for (const wl of walls) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(wl.w, h, wl.d), mat)
        m.position.set(wl.x - cx, h / 2, wl.z - cz)
        m.castShadow = true; m.receiveShadow = true
        root.add(m)
      }
    }

    for (const it of plan.items) {
      const preset = PRESET_PARTS[it.kind] || null
      const active = selected?.type === 'item' && selected.id === it.id
      const g = new THREE.Group()
      g.position.set(it.x - cx, 0, it.z - cz)
      g.rotation.y = -(it.rot * Math.PI) / 180
      const base = new THREE.Color(it.color)
      if (preset) {
        for (const part of preset) {
          const color = part.c === 'seat' ? base : part.c === 'back' ? base.clone().multiplyScalar(0.85) : part.c === 'leg' ? base.clone().multiplyScalar(0.6) : part.c === 'top' ? base.clone().multiplyScalar(1.1) : part.c === 'soft' ? base.clone().offsetHSL(0, -0.1, 0.12) : base
          const m = new THREE.Mesh(new THREE.BoxGeometry(part.w, part.h, part.d), new THREE.MeshStandardMaterial({ color, roughness: 0.75 }))
          m.position.set(part.x + part.w / 2, part.y + part.h / 2, part.z + part.d / 2)
          m.castShadow = true
          g.add(m)
        }
      } else {
        const m = new THREE.Mesh(new THREE.BoxGeometry(it.w, it.h, it.d), new THREE.MeshStandardMaterial({ color: base, roughness: 0.7 }))
        m.position.set(it.w / 2, it.h / 2, it.d / 2)
        m.castShadow = true
        g.add(m)
      }
      if (active) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(it.w + 0.06, it.h + 0.06, it.d + 0.06), new THREE.MeshBasicMaterial({ color: new THREE.Color('#2f81f7'), wireframe: true }))
        box.position.set(it.w / 2, it.h / 2, it.d / 2)
        g.add(box)
      }
      root.add(g)
    }

    scene.add(new THREE.HemisphereLight(0xffffff, 0x222633, 0.9))
    const dir = new THREE.DirectionalLight(0xffffff, 1.1)
    dir.position.set(8, 14, 6)
    dir.castShadow = true
    dir.shadow.mapSize.set(1024, 1024)
    dir.shadow.camera.left = -20; dir.shadow.camera.right = 20; dir.shadow.camera.top = 20; dir.shadow.camera.bottom = -20
    scene.add(dir)
    const grid = new THREE.GridHelper(40, 40, 0x2a3040, 0x1d2230)
    grid.position.set(0, 0.001, 0)
    scene.add(grid)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI / 2.05
    const span = Math.max(6, Math.max(maxX - minX, maxZ - minZ))
    camera.position.set(span * 0.9, span * 0.85, span * 1.1)
    controls.target.set(0, 1.1, 0)
    controls.update()

    // 第一人称：WASD 移动 + 拖拽转头
    const st = stateRef.current
    st.camera = camera
    st.controls = controls
    const onKey = (e: KeyboardEvent) => {
      st.keys[e.key.toLowerCase()] = e.type === 'keydown'
      if (firstPerson && ['w', 'a', 's', 'd'].includes(e.key.toLowerCase())) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)

    let yaw = Math.PI, pitch = 0
    const onDrag = (e: PointerEvent) => {
      if (!firstPerson || !st.dragging) return
      yaw -= e.movementX * 0.0025
      pitch = Math.max(-1.2, Math.min(1.2, pitch - e.movementY * 0.0025))
    }
    const onDown = () => { st.dragging = true }
    const onUp = () => { st.dragging = false }
    renderer.domElement.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointermove', onDrag)

    let raf = 0
    const clock = new THREE.Clock()
    const tick = () => {
      const dt = clock.getDelta()
      if (firstPerson) {
        camera.rotation.order = 'YXZ'
        camera.rotation.y = yaw
        camera.rotation.x = pitch
        const speed = (st.keys.shift ? 6 : 3) * dt
        const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
        const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
        if (st.keys.w) camera.position.addScaledVector(fwd, speed)
        if (st.keys.s) camera.position.addScaledVector(fwd, -speed)
        if (st.keys.a) camera.position.addScaledVector(right, -speed)
        if (st.keys.d) camera.position.addScaledVector(right, speed)
        camera.position.y = 1.6
      } else {
        controls.update()
      }
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()
    const onResize = () => {
      const w = el.clientWidth, h = el.clientHeight
      if (!w || !h) return
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h)
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointermove', onDrag)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      controls.dispose(); renderer.dispose(); el.innerHTML = ''
    }
  }, [plan, selected, firstPerson])

  return (
    <div className="relative w-full" style={{ height: 520 }}>
      <div ref={mountRef} className="w-full h-full" />
      {firstPerson && (
        <div className="absolute left-2 bottom-2 flex items-center gap-2 rounded bg-black/50 px-2 py-1 text-[11px] text-white/80">
          WASD 移动（Shift 加速）· 拖动转头
          <button type="button" className="underline" onClick={onExitFirstPerson}>退出</button>
        </div>
      )}
    </div>
  )
}

// 与 engine/scene3d.mjs 的 FURNITURE_PRESETS.parts 对齐（只取几何，颜色在渲染时按部位微调）
const PRESET_PARTS: Record<string, { x: number; y: number; z: number; w: number; h: number; d: number; c: string }[]> = {
  sofa: [{ x: 0, y: 0, z: 0, w: 2.2, h: 0.45, d: 0.9, c: 'seat' }, { x: 0, y: 0.45, z: 0.72, w: 2.2, h: 0.35, d: 0.18, c: 'back' }, { x: 0, y: 0, z: 0, w: 0.18, h: 0.6, d: 0.9, c: 'back' }, { x: 2.02, y: 0, z: 0, w: 0.18, h: 0.6, d: 0.9, c: 'back' }],
  bed: [{ x: 0, y: 0, z: 0, w: 1.8, h: 0.35, d: 2.0, c: 'seat' }, { x: 0, y: 0.35, z: 0, w: 1.8, h: 0.22, d: 1.5, c: 'soft' }, { x: 0, y: 0, z: 1.9, w: 1.8, h: 0.9, d: 0.1, c: 'back' }],
  table: [{ x: 0, y: 0.68, z: 0, w: 1.4, h: 0.07, d: 0.8, c: 'top' }, { x: 0.05, y: 0, z: 0.05, w: 0.08, h: 0.68, d: 0.08, c: 'leg' }, { x: 1.27, y: 0, z: 0.05, w: 0.08, h: 0.68, d: 0.08, c: 'leg' }, { x: 0.05, y: 0, z: 0.67, w: 0.08, h: 0.68, d: 0.08, c: 'leg' }, { x: 1.27, y: 0, z: 0.67, w: 0.08, h: 0.68, d: 0.08, c: 'leg' }],
  chair: [{ x: 0, y: 0.42, z: 0, w: 0.5, h: 0.06, d: 0.5, c: 'top' }, { x: 0, y: 0.48, z: 0.44, w: 0.5, h: 0.42, d: 0.06, c: 'back' }],
  cabinet: [{ x: 0, y: 0, z: 0, w: 1.2, h: 2.0, d: 0.45, c: 'seat' }],
  rug: [{ x: 0, y: 0, z: 0, w: 2.4, h: 0.02, d: 1.6, c: 'soft' }],
  plant: [{ x: 0.18, y: 0, z: 0.18, w: 0.14, h: 0.35, d: 0.14, c: 'leg' }, { x: 0, y: 0.35, z: 0, w: 0.5, h: 0.75, d: 0.5, c: 'soft' }],
  door: [{ x: 0, y: 0, z: 0, w: 0.9, h: 2.0, d: 0.1, c: 'seat' }],
  window: [{ x: 0, y: 0.9, z: 0, w: 1.4, h: 1.2, d: 0.1, c: 'soft' }],
}
