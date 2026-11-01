import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Download, Plus, Save, RotateCcw } from 'lucide-react'
import { api } from '../api'

// ── 创作台 · 3D 空间（2026-11-01）──
// 左边画户型（拖拽出房间、点一下放家具），右边 three.js 实时漫游，
// 保存成 JSON、导出一个不依赖任何外部库的单文件 HTML。

type Room = { id: string; name: string; x: number; z: number; w: number; d: number; h: number; color: string }
type Item = { id: string; kind: string; x: number; z: number; w: number; d: number; h: number; color: string }
type Plan = { name: string; rooms: Room[]; items: Item[] }

const EMPTY: Plan = { name: '我的空间', rooms: [], items: [] }
const uid = () => Math.random().toString(36).slice(2, 8)
const PX_PER_M = 46

export default function Scene3DTab() {
  const [plan, setPlan] = useState<Plan>(EMPTY)
  const [tool, setTool] = useState<'room' | 'item'>('room')
  const [price, setPrice] = useState('0')
  const [msg, setMsg] = useState('')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<{ x: number; z: number } | null>(null)
  const plans = useSWR('scene3d-list', () => api<{ items: { name: string }[] }>('/api/scene3d/list'), { refreshInterval: 0 })

  const stats = useMemo(() => {
    const area = plan.rooms.reduce((a, r) => a + r.w * r.d, 0)
    const per = Number(price) || 0
    return { area: Math.round(area * 100) / 100, cost: Math.round(area * per) }
  }, [plan.rooms, price])

  // ── 2D 画布：拖拽建房间 / 点击放家具 ──
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
    const ox = 24, oz = 24
    const toScreen = (x: number, z: number) => ({ X: ox + x * PX_PER_M, Y: oz + z * PX_PER_M })
    ctx.strokeStyle = 'rgba(140,150,165,0.14)'
    for (let i = 0; i <= Math.ceil(w / PX_PER_M); i += 1) {
      ctx.beginPath(); ctx.moveTo(ox + i * PX_PER_M, oz); ctx.lineTo(ox + i * PX_PER_M, h); ctx.stroke()
    }
    for (let j = 0; j <= Math.ceil(h / PX_PER_M); j += 1) {
      ctx.beginPath(); ctx.moveTo(ox, oz + j * PX_PER_M); ctx.lineTo(w, oz + j * PX_PER_M); ctx.stroke()
    }
    for (const r of plan.rooms) {
      const p = toScreen(r.x, r.z)
      ctx.fillStyle = r.color
      ctx.globalAlpha = 0.55
      ctx.fillRect(p.X, p.Y, r.w * PX_PER_M, r.d * PX_PER_M)
      ctx.globalAlpha = 1
      ctx.strokeStyle = 'rgba(90,100,120,0.9)'
      ctx.lineWidth = 1.5
      ctx.strokeRect(p.X, p.Y, r.w * PX_PER_M, r.d * PX_PER_M)
      ctx.fillStyle = 'rgba(40,45,55,0.85)'
      ctx.font = '11px system-ui'
      ctx.fillText(`${r.name} ${(r.w * r.d).toFixed(1)}㎡`, p.X + 6, p.Y + 15)
    }
    for (const it of plan.items) {
      const p = toScreen(it.x, it.z)
      ctx.fillStyle = it.color
      ctx.fillRect(p.X, p.Y, it.w * PX_PER_M, it.d * PX_PER_M)
      ctx.strokeStyle = 'rgba(40,45,55,0.7)'
      ctx.strokeRect(p.X, p.Y, it.w * PX_PER_M, it.d * PX_PER_M)
    }
  }, [plan])

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = e.currentTarget
    const rect = cv.getBoundingClientRect()
    const x = (e.clientX - rect.left - 24) / PX_PER_M
    const z = (e.clientY - rect.top - 24) / PX_PER_M
    return { x: Math.max(0, Math.round(x * 20) / 20), z: Math.max(0, Math.round(z * 20) / 20) }
  }

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointFromEvent(e)
    if (tool === 'item') {
      setPlan((prev) => ({ ...prev, items: [...prev.items, { id: uid(), kind: 'box', x: p.x, z: p.z, w: 0.9, d: 0.6, h: 0.75, color: '#b98b5e' }] }))
      return
    }
    dragRef.current = p
  }
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool !== 'room' || !dragRef.current) return
    const start = dragRef.current
    dragRef.current = null
    const end = pointFromEvent(e)
    const w = Math.max(0.5, Math.round(Math.abs(end.x - start.x) * 20) / 20)
    const d = Math.max(0.5, Math.round(Math.abs(end.z - start.z) * 20) / 20)
    const x = Math.min(start.x, end.x), z = Math.min(start.z, end.z)
    if (w < 1 || d < 1) return
    setPlan((prev) => ({ ...prev, rooms: [...prev.rooms, { id: uid(), name: `房间${prev.rooms.length + 1}`, x, z, w, d, h: 2.8, color: '#e8e2d8' }] }))
  }

  const save = async () => {
    const out: any = await api('/api/scene3d/save', { method: 'POST', body: { plan } }).catch((e: any) => ({ ok: false, error: e?.message }))
    setMsg(out?.ok ? `已保存：${out.name}` : `保存失败：${out?.error || '未知'}`)
    if (out?.ok) void plans.mutate()
  }
  const exportIt = async () => {
    const out: any = await api('/api/scene3d/export', { method: 'POST', body: { plan, pricePerSqm: Number(price) || 0 } }).catch((e: any) => ({ ok: false, error: e?.message }))
    setMsg(out?.ok ? `已导出单文件：${out.file}（${(out.bytes / 1024).toFixed(0)} KB）` : `导出失败：${out?.error || '未知'}`)
  }
  const load = async (name: string) => {
    const out: any = await api(`/api/scene3d/plan?name=${encodeURIComponent(name)}`).catch(() => null)
    if (out?.plan) { setPlan(out.plan); setMsg(`已载入：${name}`) }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <section className="panel p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input value={plan.name} onChange={(e) => setPlan((p) => ({ ...p, name: e.target.value }))}
            className="min-w-0 flex-1 rounded-pi-md border border-pi-border-soft bg-pi-bg2 px-2 py-1.5 text-[13px]" placeholder="空间名" />
          <button type="button" onClick={() => setTool('room')}
            className={`min-h-9 px-2.5 rounded-pi-md text-[12px] ${tool === 'room' ? 'bg-pi-accent text-pi-on-accent' : 'text-pi-dim hover:text-pi-text'}`}>画房间</button>
          <button type="button" onClick={() => setTool('item')}
            className={`min-h-9 px-2.5 rounded-pi-md text-[12px] ${tool === 'item' ? 'bg-pi-accent text-pi-on-accent' : 'text-pi-dim hover:text-pi-text'}`}>放家具</button>
        </div>
        <canvas ref={canvasRef} onPointerDown={onDown} onPointerUp={onUp}
          className="w-full rounded-pi-md border border-pi-border-soft bg-pi-bg2" style={{ height: 340, touchAction: 'none' }} />
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-pi-dim2">
          <span>面积 {stats.area} ㎡</span>
          <label className="flex items-center gap-1">单价¥
            <input value={price} onChange={(e) => setPrice(e.target.value)} className="w-16 rounded border border-pi-border-soft bg-pi-bg2 px-1 py-0.5" />
          </label>
          <span>估算 ¥{stats.cost.toLocaleString()}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void save()} className="inline-flex items-center gap-1 min-h-9 px-3 rounded-pi-md bg-pi-bg3 text-[12px]"><Save className="w-3.5 h-3.5" />保存</button>
          <button type="button" onClick={() => void exportIt()} className="inline-flex items-center gap-1 min-h-9 px-3 rounded-pi-md bg-pi-bg3 text-[12px]"><Download className="w-3.5 h-3.5" />导出单文件</button>
          <button type="button" onClick={() => setPlan({ ...EMPTY, name: plan.name })} className="inline-flex items-center gap-1 min-h-9 px-3 rounded-pi-md text-pi-dim text-[12px]"><RotateCcw className="w-3.5 h-3.5" />清空</button>
          <button type="button" onClick={() => setPlan((p) => ({ ...p, rooms: [...p.rooms, { id: uid(), name: `房间${p.rooms.length + 1}`, x: 0, z: 0, w: 4, d: 3, h: 2.8, color: '#e8e2d8' }] }))}
            className="inline-flex items-center gap-1 min-h-9 px-3 rounded-pi-md text-pi-dim text-[12px]"><Plus className="w-3.5 h-3.5" />加一间</button>
        </div>
        {msg && <p className="text-[12px] text-pi-text break-all">{msg}</p>}
        {(plans.data?.items || []).length > 0 && (
          <div className="border-t border-pi-border-soft pt-2">
            <p className="text-[11px] text-pi-dim2 mb-1">已保存</p>
            <div className="flex flex-wrap gap-1">
              {(plans.data?.items || []).slice(0, 8).map((it) => (
                <button key={it.name} type="button" onClick={() => void load(it.name)} className="text-[11px] px-2 py-1 rounded bg-pi-bg3 text-pi-dim hover:text-pi-text">{it.name}</button>
              ))}
            </div>
          </div>
        )}
      </section>
      <section className="panel p-0 overflow-hidden" style={{ minHeight: 480 }}>
        <Scene3DView plan={plan} />
      </section>
    </div>
  )
}

function Scene3DView({ plan }: { plan: Plan }) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#141821')
    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / Math.max(1, el.clientHeight), 0.1, 500)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI / 2.05

    const root = new THREE.Group()
    scene.add(root)
    const rooms = plan.rooms.length ? plan.rooms : [{ id: 'p', name: '房间', x: 0, z: 0, w: 6, d: 4, h: 2.8, color: '#e8e2d8' }]
    const minX = Math.min(...rooms.map((r) => r.x)), maxX = Math.max(...rooms.map((r) => r.x + r.w))
    const minZ = Math.min(...rooms.map((r) => r.z)), maxZ = Math.max(...rooms.map((r) => r.z + r.d))
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
    for (const r of rooms) {
      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(r.w, 0.08, r.d),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(r.color), roughness: 0.9 }),
      )
      floor.position.set(r.x + r.w / 2 - cx, -0.04, r.z + r.d / 2 - cz)
      root.add(floor)
      const h = r.h
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#cfc7b8'), roughness: 0.85, transparent: true, opacity: 0.55 })
      const walls = [
        { w: r.w, d: 0.08, x: r.x + r.w / 2 - cx, z: r.z - cz },
        { w: r.w, d: 0.08, x: r.x + r.w / 2 - cx, z: r.z + r.d - cz },
        { w: 0.08, d: r.d, x: r.x - cx, z: r.z + r.d / 2 - cz },
        { w: 0.08, d: r.d, x: r.x + r.w - cx, z: r.z + r.d / 2 - cz },
      ]
      for (const wl of walls) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(wl.w, h, wl.d), mat)
        m.position.set(wl.x, h / 2, wl.z)
        root.add(m)
      }
    }
    for (const it of plan.items) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(it.w, it.h, it.d), new THREE.MeshStandardMaterial({ color: new THREE.Color(it.color), roughness: 0.7 }))
      m.position.set(it.x + it.w / 2 - cx, it.h / 2, it.z + it.d / 2 - cz)
      root.add(m)
    }
    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2f3a, 0.85))
    const dir = new THREE.DirectionalLight(0xffffff, 0.9)
    dir.position.set(6, 12, 8)
    scene.add(dir)
    const span = Math.max(6, Math.max(maxX - minX, maxZ - minZ))
    camera.position.set(span * 0.9, span * 0.8, span * 1.1)
    controls.target.set(0, 1.2, 0)
    controls.update()

    let raf = 0
    const tick = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(tick) }
    tick()
    const onResize = () => {
      const w = el.clientWidth, h = el.clientHeight
      if (!w || !h) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      controls.dispose()
      renderer.dispose()
      el.innerHTML = ''
    }
  }, [plan])
  return <div ref={mountRef} className="w-full" style={{ height: 480 }} />
}
