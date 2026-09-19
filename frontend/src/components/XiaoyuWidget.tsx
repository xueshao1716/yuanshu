import { useEffect, useRef, useState } from 'react'

// 小语挂件（2026-09-19 v5：自由漫游 + 互动）
// 先说清一件事：**"在屏幕上自由乱跑 + 能互动"不需要 Live2D**。
// Live2D/Rive 解决的是"形变质量"（头发飘、呼吸、视线跟随、口型）；乱跑/互动是**行为层**：
// 一个状态机（待机/漫游/被抓/掉落/困）+ 位移插值 + CSS 形变就够，而且用的是**你自己的立绘**。
// 所以这里做的模式是：角落待命（默认）⇄ 自由漫游（在视口里飘着走，避开输入区）。
// 手势：单击=反应说话 · 双击=换装 · 拖动=抓起来（松手掉到下方再继续飘）· 悬停=注视你。
const S = '/static/branding'
const V = '?v=7'
type FrameKey = 'open' | 'closed' | 'happy' | 'focused' | 'thinking' | 'sleepy' | 'wave'

const SKINS: Record<string, { label: string; frames: Record<FrameKey, string>; walk: string[] }> = {
  chibi: {
    label: 'Q版',
    // 走路循环 4 帧（侧身迈步→并拢→迈步→并拢），漫游时按移动速度播放
    walk: [`${S}/walk-05-256.png${V}`, `${S}/walk-06-256.png${V}`, `${S}/walk-07-256.png${V}`, `${S}/walk-08-256.png${V}`],
    frames: {
      open: `${S}/xiaoyu-open-t.png${V}`,
      closed: `${S}/xiaoyu-closed-t.png${V}`,
      happy: `${S}/xiaoyu-happy-t.png${V}`,
      focused: `${S}/xiaoyu-focused-t.png${V}`,
      thinking: `${S}/xiaoyu-thinking-t.png${V}`,
      sleepy: `${S}/xiaoyu-sleepy-t.png${V}`,
      wave: `${S}/xiaoyu-wave-t.png${V}`,
    },
  },
  doll: {
    label: '盲盒公仔',
    walk: [`${S}/walk-01-256.png${V}`, `${S}/walk-02-256.png${V}`, `${S}/walk-03-256.png${V}`, `${S}/walk-04-256.png${V}`],
    frames: {
      open: `${S}/doll-02.png${V}`, closed: `${S}/doll-02.png${V}`, happy: `${S}/doll-01.png${V}`,
      focused: `${S}/doll-02.png${V}`, thinking: `${S}/doll-02.png${V}`, sleepy: `${S}/doll-02.png${V}`, wave: `${S}/doll-01.png${V}`,
    },
  },
}

const LINES = ['在。有活就说。', '我盯着任务呢，跑完会汇报。', '要查什么、要写什么，直接说。', '我自己溜达一会儿，有事叫我。']

// 第三套皮肤：**可动（木偶）**。两条渲染路径，取决于有没有人工标注：
//   ① 有 /static/puppet/puppet.json（标注页拖框 → `node scripts/puppet-build.mjs` 切出来的部件）
//      → **按部件 + 骨骼渲染**：头/双臂/双腿各有自己的枢轴，可以独立旋转（点头、摆手、迈步、身体前倾）；
//   ② 没有 → 退回"整图横向切片 + 弯曲曲线"的形变（四肢不独立，但至少有体态）。
// 两条都是纯代码，不需要 Live2D / Rive 之类 GUI 编辑器。
type PuppetPart = { file: string; x: number; y: number; w: number; h: number; pivot: [number, number]; z: number }
function PuppetCanvas({ src, walking, hover, face, label, waving }: { src: string; walking: boolean; hover: boolean; face: number; label: string; waving: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [ready, setReady] = useState(false)
  const partsRef = useRef<{ size: [number, number]; parts: Record<string, PuppetPart>; imgs: Record<string, HTMLImageElement> } | null>(null)

  useEffect(() => {
    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.onload = () => { imgRef.current = im; setReady(true) }
    im.src = src
  }, [src])

  // 拉骨骼清单（有就用部件渲染）
  useEffect(() => {
    let alive = true
    fetch('/static/puppet/puppet.json?t=' + Math.floor(Date.now() / 60000))
      .then((r) => (r.ok ? r.json() : null))
      .then(async (j) => {
        if (!alive || !j?.parts) return
        const imgs: Record<string, HTMLImageElement> = {}
        await Promise.all(Object.entries(j.parts as Record<string, PuppetPart>).map(([k, p]) => new Promise<void>((res) => {
          const im = new Image(); im.onload = () => { imgs[k] = im; res() }; im.onerror = () => res(); im.src = '/static/puppet/' + p.file
        })))
        if (alive) partsRef.current = { size: j.size, parts: j.parts, imgs }
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!ready) return
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    let raf = 0
    const t0 = performance.now()
    const STRIPS = 22
    const draw = (now: number) => {
      const t = (now - t0) / 1000
      const W = cv.width, H = cv.height
      ctx.clearRect(0, 0, W, H)
      const P = partsRef.current
      if (P && Object.keys(P.imgs).length >= 4) {
        // ── 部件 + **骨骼树**（父节点旋转带动子节点：走路时大腿带小腿、上臂带小臂）──
        const s = W / P.size[0]
        const swing = walking ? Math.sin(t * 6.2) : 0                       // 迈步相位
        const breathe = 1 + Math.sin(t * 1.1) * 0.01
        const bob = walking ? Math.sin(t * 12.4) * 1.6 : Math.sin(t * 1.1) * 0.5
        const lean = walking ? Math.sin(t * 6.2) * 1.6 : Math.sin(t * 0.7) * 0.5
        const angles: Record<string, number> = {
          torso: lean,
          head: (hover ? 3 : 1.2 * Math.sin(t * 1.15)) + lean * 0.3,
          // 手臂：走路时前后摆（上臂大、小臂带相位延迟）；挥手时右臂抬起画弧
          upperArmL: walking ? swing * 15 : Math.sin(t * 1.0) * 1.5,
          foreArmL: walking ? swing * 9 : Math.sin(t * 1.0 + 0.5) * 1.2,
          upperArmR: waving ? -62 + Math.sin(t * 7.5) * 6 : walking ? -swing * 15 : -Math.sin(t * 1.0) * 1.5,
          foreArmR: waving ? Math.sin(t * 7.5 + 0.6) * 26 : walking ? -swing * 9 : -Math.sin(t * 1.0 + 0.5) * 1.2,
          // 腿：大腿摆、小臂小腿跟着带相位差（比同相摆动自然得多）
          thighL: walking ? -swing * 17 : 0,
          shinL: walking ? Math.max(0, swing) * 22 : 0,
          thighR: walking ? swing * 17 : 0,
          shinR: walking ? Math.max(0, -swing) * 22 : 0,
        }
        const parent: Record<string, string> = {
          head: 'torso', upperArmL: 'torso', foreArmL: 'upperArmL', upperArmR: 'torso', foreArmR: 'upperArmR',
          thighL: 'torso', shinL: 'thighL', thighR: 'torso', shinR: 'thighR',
        }
        const hipY = P.parts.torso ? P.parts.torso.y + P.parts.torso.pivot[1] : P.size[1]
        // 两遍就能算出正运动学：第一遍父节点，第二遍子节点
        const world: Record<string, { x: number; y: number; rot: number }> = {}
        const ids = Object.keys(P.parts).sort((a, b) => (parent[a] ? 1 : 0) - (parent[b] ? 1 : 0))
        for (const id of ids) {
          const p = P.parts[id]
          const ax = p.x + p.pivot[0], ay = p.y + p.pivot[1]
          const pa = parent[id]
          const pw = pa && world[pa]
          const rot = ((angles[id] || 0) * Math.PI) / 180
          if (!pw) { world[id] = { x: ax, y: ay, rot }; continue }
          const dx = ax - world[pa].x, dy = ay - world[pa].y
          const c = Math.cos(world[pa].rot), sn = Math.sin(world[pa].rot)
          world[id] = { x: world[pa].x + dx * c - dy * sn, y: world[pa].y + dx * sn + dy * c, rot: world[pa].rot + rot }
        }
        ctx.save()
        ctx.translate(W / 2, H - bob)
        for (const [k, p] of Object.entries(P.parts).sort((a, b) => a[1].z - b[1].z)) {
          const im = P.imgs[k]
          const w = world[k]
          if (!im || !w) continue
          ctx.save()
          ctx.translate((w.x - P.size[0] / 2) * s, (w.y - (parent[k] ? hipY : hipY)) * s)
          ctx.rotate(w.rot)
          if (k === 'torso') ctx.scale(1, breathe)
          ctx.scale(s * face, s)
          ctx.drawImage(im, -p.pivot[0], -p.pivot[1])
          ctx.restore()
        }
        ctx.restore()
      } else if (imgRef.current) {
        // ── 退回：整图切片形变 ──
        const im = imgRef.current
        const breathe = 1 + Math.sin(t * 1.1) * 0.006
        const lean = walking ? Math.sin(t * 6.2) * 1.0 : Math.sin(t * 0.7) * 0.35
        const sh = H / STRIPS
        for (let i = 0; i < STRIPS; i++) {
          const y = i * sh
          const p = i / (STRIPS - 1)
          const legPart = Math.max(0, p - 0.5) / 0.5
          const bend = walking ? Math.sin(t * 6.2 + p * 2.4) * 1.8 * legPart : Math.sin(t * 0.9 + p * 1.6) * 0.5 * legPart
          const sway = Math.sin(t * 1.15) * 0.5 * (1 - p)
          ctx.drawImage(im, 0, (im.height * y) / H, im.width, (im.height * sh) / H,
            bend + lean * (1 - p) + sway, y + (H - H * breathe) / 2, W, sh * breathe + 0.6)
        }
      }
      if (hover) {
        ctx.save(); ctx.globalAlpha = 0.16; ctx.fillStyle = '#fff'
        ctx.beginPath(); ctx.ellipse(W / 2, H * 0.14, W * 0.2, H * 0.045, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [ready, walking, hover, face, waving])

  return <canvas ref={ref} width={Math.round((partsRef.current?.size?.[0] || 192) * 0.9)} height={Math.round((partsRef.current?.size?.[1] || 224) * 0.9)}
    aria-label={label} data-puppet="1" data-puppet-mode={partsRef.current ? 'parts' : 'strips'} className="h-20 w-auto sm:h-24" />
}

// 皮肤表：puppet 复用 Q版的素材（同一批透明图），只是渲染方式换成上面的切片形变
SKINS.puppet = { label: 'Q版·可动', frames: SKINS.chibi.frames, walk: SKINS.chibi.walk }
const TALK_CYCLE: FrameKey[] = ['open', 'happy', 'open', 'thinking', 'happy', 'open']
const IDLE_FACES: FrameKey[] = ['happy', 'thinking', 'sleepy', 'focused']
const IDLE_SLEEP_MS = 3 * 60 * 1000
const W = 96            // 立绘宽度基准（px）
const H = 112           // 立绘高度基准
const SPEED = 46        // 漫游速度 px/s
const GRAVITY = 900     // 松手后的"掉下去"加速度

function runningCount(raw: any): number {
  const list = Array.isArray(raw) ? raw : (raw?.tasks || raw?.items || raw?.list || [])
  if (!Array.isArray(list)) return 0
  return list.filter((t: any) => {
    const s = String(t?.status || t?.state || '').toLowerCase()
    return t?.running === true || ['running', 'in_progress', 'executing', 'working'].includes(s)
  }).length
}

export default function XiaoyuWidget() {
  const [frame, setFrame] = useState<FrameKey>('wave')
  const [open, setOpen] = useState(false)
  const [skin, setSkin] = useState<string>(() => { try { return localStorage.getItem('xiaoyu_skin') || 'chibi' } catch { return 'chibi' } })
  const [mode, setMode] = useState<'corner' | 'roam'>(() => { try { return (localStorage.getItem('xiaoyu_mode') as any) || 'corner' } catch { return 'corner' } })
  const [pos, setPos] = useState<{ x: number; y: number; face: number } | null>(null)
  const [hover, setHover] = useState(false)
  const [walking, setWalking] = useState(false)
  const [waving, setWaving] = useState(false)   // 挥手：点她时抬右臂画弧，1.4 秒后放下
  const [walkIdx, setWalkIdx] = useState(0)
  const walkClock = useRef(0)
  const [sparks, setSparks] = useState<{ id: number; x: number; y: number }[]>([])
  const [persona, setPersona] = useState<{ name?: string; age?: number } | null>(null)
  const [line, setLine] = useState(LINES[0])
  const [busyCount, setBusyCount] = useState(0)

  const boxRef = useRef<HTMLDivElement | null>(null)
  const talkingRef = useRef(false)
  const hoverRef = useRef(false)   // 悬停时"注视"要压过眨眼/漫游的换帧（真机核对里被漫游覆盖过）
  const walkRef = useRef(false)
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null)
  const phys = useRef({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, falling: false, nextThink: 0, face: 1 })

  useEffect(() => { for (const s of Object.values(SKINS)) for (const src of [...Object.values(s.frames), ...s.walk]) { const i = new Image(); i.src = src } }, [])
  useEffect(() => { const t = setTimeout(() => setFrame('open'), 1800); return () => clearTimeout(t) }, [])

  // 眨眼
  useEffect(() => {
    let t1: ReturnType<typeof setTimeout>, t2: ReturnType<typeof setTimeout>
    const loop = () => {
      t1 = setTimeout(() => {
        if (!talkingRef.current && !hoverRef.current) setFrame('closed')
        t2 = setTimeout(() => { if (!talkingRef.current && !hoverRef.current) setFrame('open'); loop() }, 130)
      }, 3500 + Math.random() * 2500)
    }
    loop()
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  // 空闲换表情
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const loop = () => {
      t = setTimeout(() => {
        if (!talkingRef.current && !hoverRef.current && !open) {
          setFrame(IDLE_FACES[Math.floor(Math.random() * IDLE_FACES.length)])
          setTimeout(() => { if (!talkingRef.current) setFrame('open') }, 1600)
        }
        loop()
      }, 15000 + Math.random() * 10000)
    }
    loop()
    return () => clearTimeout(t)
  }, [open])

  // 名字/年龄读人格定义
  useEffect(() => {
    let alive = true
    fetch('/api/persona', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('yuanshu_access_token') || '') } })
      .then((r) => r.json()).then((d) => { if (alive && d?.definition) setPersona({ name: d.definition.name, age: d.definition.age }) }).catch(() => {})
    return () => { alive = false }
  }, [])

  // 任务状态 → 表情
  const lastBusy = useRef(false)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch('/api/tasks', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('yuanshu_access_token') || '') } })
        const n = runningCount(await r.json())
        if (!alive) return
        setBusyCount(n)
        const busy = n > 0
        if (busy && !talkingRef.current) setFrame('focused')
        else if (!busy && lastBusy.current && !talkingRef.current) { setFrame('happy'); setTimeout(() => { if (!talkingRef.current) setFrame('open') }, 2500) }
        lastBusy.current = busy
      } catch {}
    }
    tick()
    const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // 久未交互 → 困
  useEffect(() => {
    let last = Date.now()
    const touch = () => { last = Date.now() }
    const evs = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'] as const
    for (const ev of evs) window.addEventListener(ev, touch, { passive: true })
    const t = setInterval(() => {
      if (talkingRef.current) return
      if (Date.now() - last > IDLE_SLEEP_MS) setFrame((f) => (f === 'closed' ? f : 'sleepy'))
    }, 20000)
    return () => { for (const ev of evs) window.removeEventListener(ev, touch); clearInterval(t) }
  }, [])

  // ── 漫游引擎：目标点 + 速度插值 + 松手重力；在视口里自由走，避开底部输入区 ──
  useEffect(() => {
    if (mode !== 'roam') { setPos(null); return }
    const vw = () => window.innerWidth
    const vh = () => window.innerHeight
    const safeBottom = () => (vw() < 700 ? 200 : 140)          // 手机避开输入区
    const pick = () => {
      const p = phys.current
      p.tx = 30 + Math.random() * Math.max(60, vw() - W - 60)
      p.ty = 60 + Math.random() * Math.max(60, vh() - H - safeBottom() - 60)
      p.nextThink = performance.now() + 3000 + Math.random() * 4000
    }
    const p = phys.current
    p.x = Math.min(vw() - W - 20, Math.max(20, vw() * 0.62)); p.y = vh() * 0.55
    pick()
    let raf = 0
    let prev = performance.now()
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now
      const q = phys.current
      if (dragRef.current) { raf = requestAnimationFrame(step); return }
      if (q.falling) {                                   // 松手后掉下去，落地再继续飘
        q.vy += GRAVITY * dt
        q.y += q.vy * dt
        const ground = vh() - H - safeBottom() + 60
        if (q.y >= ground) { q.y = ground; q.vy = 0; q.falling = false; pick() }
      } else {
        const dx = q.tx - q.x, dy = q.ty - q.y
        const dist = Math.hypot(dx, dy)
        if (dist < 8 || now > q.nextThink) {
          if (Math.random() < 0.35 && !talkingRef.current && !hoverRef.current) { setFrame('thinking'); setTimeout(() => { if (!talkingRef.current && !hoverRef.current) setFrame('open') }, 900) }
          pick()
        } else {
          const vx = (dx / dist) * SPEED, vy = (dy / dist) * SPEED
          if (Math.abs(vx) > 6) q.face = vx > 0 ? 1 : -1
          q.x += vx * dt; q.y += vy * dt
          const moving = dist > 12
          if (moving !== walkRef.current) { walkRef.current = moving; setWalking(moving) }
          if (moving) { walkClock.current += dt; if (walkClock.current > 0.18) { walkClock.current = 0; setWalkIdx((i) => (i + 1) % 4) } }
        }
      }
      q.x = Math.max(8, Math.min(vw() - W - 8, q.x))
      q.y = Math.max(8, Math.min(vh() - H - 8, q.y))
      if (!q.falling && Math.hypot(q.tx - q.x, q.ty - q.y) < 10 && walkRef.current) { walkRef.current = false; setWalking(false) }
      setPos({ x: q.x, y: q.y, face: q.face })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [mode])

  // 点外面收起气泡
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  const label = persona?.name ? `${persona.name}${persona.age ? ` · ${persona.age}岁` : ''}` : '小语'
  const frames = (SKINS[skin] || SKINS.chibi).frames

  const speak = () => {
    setWaving(true)
    setTimeout(() => setWaving(false), 1400)
    setLine(LINES[Math.floor(Math.random() * LINES.length)])
    setOpen((v) => !v)
    setFrame('wave')
    talkingRef.current = true
    let i = 0
    const timer = setInterval(() => {
      setFrame(TALK_CYCLE[i % TALK_CYCLE.length]); i++
      if (i > TALK_CYCLE.length + 1) { clearInterval(timer); talkingRef.current = false; setFrame('happy') }
    }, 180)
    // 点一下冒几个小星星（纯 CSS，无依赖）
    const base = { x: 30 + Math.random() * 30, y: 6 + Math.random() * 10 }
    const add = [0, 1, 2].map((k) => ({ id: Date.now() + k, x: base.x + (k - 1) * 16, y: base.y - k * 6 }))
    setSparks((s) => [...s, ...add])
    setTimeout(() => setSparks((s) => s.filter((x) => !add.some((a) => a.id === x.id))), 900)
  }

  const switchSkin = () => {
    const order = ['chibi', 'doll', 'puppet']
    const next = order[(order.indexOf(skin) + 1) % order.length]
    setSkin(next)
    try { localStorage.setItem('xiaoyu_skin', next) } catch {}
    setLine(next === 'doll' ? '换好衣服了。盲盒公仔。' : next === 'puppet' ? '这套是"可动版"：不切帧，是代码给她做关节。' : '换回来了。Q版。')
    setOpen(true)
  }

  const setRoam = (on: boolean) => {
    const next = on ? 'roam' : 'corner'
    setMode(next)
    try { localStorage.setItem('xiaoyu_mode', next) } catch {}
    setLine(on ? '那我出去溜达了，有事叫我。' : '回到角落待命。')
    setOpen(true)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = boxRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const nx = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - d.dx))
    const ny = Math.max(4, Math.min(window.innerHeight - 60, e.clientY - d.dy))
    if (Math.abs(e.clientX - (nx + d.dx)) > 3 || Math.abs(e.clientY - (ny + d.dy)) > 3) d.moved = true
    if (mode === 'roam') { const p = phys.current; p.x = nx; p.y = ny; p.vx = 0; p.vy = 0; setPos({ x: nx, y: ny, face: p.face }) }
    else setPos({ x: nx, y: ny, face: 1 })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.moved) {
      try { localStorage.setItem('xiaoyu_pos', JSON.stringify({ x: pos?.x ?? 0, y: pos?.y ?? 0 })) } catch {}
      if (mode === 'roam') { phys.current.falling = true; phys.current.vy = 120 }   // 松手 → 掉下去再走
    } else if (e.detail >= 2) switchSkin()
  }

  const cornerStyle: React.CSSProperties = mode === 'corner' && pos && !dragRef.current && !phys.current.falling
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : mode === 'corner' && pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : {}

  return (
    <div
      ref={boxRef}
      className={mode === 'roam'
        ? 'fixed z-[var(--pi-z-topbar)] select-none touch-none'
        : 'fixed right-3 bottom-[calc(env(safe-area-inset-bottom,0px)+72px)] sm:bottom-6 z-[var(--pi-z-topbar)] select-none touch-none'}
      style={mode === 'roam' && pos ? { left: pos.x, top: pos.y } : cornerStyle}
    >
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-60 panel !p-2.5 text-[12px] leading-relaxed text-pi-text" role="dialog" aria-label="小语">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-pi-dim2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {label}
            <span className="ml-auto text-[10px] text-pi-dim2">{(SKINS[skin] || SKINS.chibi).label} · {mode === 'roam' ? '自由活动中' : '角落待命'}</span>
          </div>
          <div>{line}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            <button type="button" onClick={(e) => { e.stopPropagation(); setRoam(mode !== 'roam') }}
              className="rounded-pi-pill bg-white/[0.06] px-2 py-1 text-[11px] hover:bg-white/[0.12]">
              {mode === 'roam' ? '回角落' : '自由活动'}
            </button>
            <button type="button" onClick={(e) => { e.stopPropagation(); switchSkin() }}
              className="rounded-pi-pill bg-white/[0.06] px-2 py-1 text-[11px] hover:bg-white/[0.12]">换装</button>
            <a href="/static/branding/xiaoyu-open-t.png?v=6" download
              className="rounded-pi-pill bg-white/[0.06] px-2 py-1 text-[11px] hover:bg-white/[0.12]">下载立绘</a>
          </div>
        </div>
      )}
      {sparks.map((s) => (
        <span key={s.id} className="xiaoyu-spark pointer-events-none absolute text-[13px]"
          style={{ left: s.x, top: s.y }}>✦</span>
      ))}
      <button
        type="button"
        aria-label={`${label}（单击说话 · 双击换装 · 可拖动）`}
        title={`${label}｜单击说话 · 双击换装 · 拖我换位置`}
        onClick={speak}
        onDoubleClick={switchSkin}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onMouseEnter={() => { setHover(true); hoverRef.current = true; if (!talkingRef.current) setFrame('focused') }}
        onMouseLeave={() => { setHover(false); hoverRef.current = false; if (!talkingRef.current) setFrame('open') }}
        data-frame={walking ? 'walk' + (walkIdx + 1) : frame}
        data-skin={skin}
        data-mode={mode}
        data-tasks={busyCount}
        className="xiaoyu-widget block cursor-grab active:cursor-grabbing transition-transform duration-150 hover:scale-105"
        style={{
          filter: 'drop-shadow(0 6px 14px rgba(0,0,0,.45))',
          transform: `${mode === 'roam' && pos ? `scaleX(${pos.face})` : ''} ${hover ? 'translateY(-2px)' : ''}`.trim() || undefined,
        }}
      >
        {skin === 'puppet' ? (
          <PuppetCanvas src={walking && (SKINS[skin] || SKINS.chibi).walk[walkIdx] ? (SKINS[skin] || SKINS.chibi).walk[walkIdx] : frames[frame]}
            walking={walking} hover={hover} waving={waving} face={mode === 'roam' && pos ? pos.face : 1} label={label} />
        ) : (
          <img src={walking && (SKINS[skin] || SKINS.chibi).walk[walkIdx] ? (SKINS[skin] || SKINS.chibi).walk[walkIdx] : frames[frame]} alt={label} draggable={false} className="h-20 w-auto sm:h-24" />
        )}
      </button>
    </div>
  )
}
