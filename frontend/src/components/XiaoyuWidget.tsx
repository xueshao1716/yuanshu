import { useEffect, useRef, useState } from 'react'

// 小语挂件（2026-09-19 v5：自由漫游 + 互动）
// 先说清一件事：**"在屏幕上自由乱跑 + 能互动"不需要 Live2D**。
// Live2D/Rive 解决的是"形变质量"（头发飘、呼吸、视线跟随、口型）；乱跑/互动是**行为层**：
// 一个状态机（待机/漫游/被抓/掉落/困）+ 位移插值 + CSS 形变就够，而且用的是**你自己的立绘**。
// 所以这里做的模式是：角落待命（默认）⇄ 自由漫游（在视口里飘着走，避开输入区）。
// 手势：单击=反应说话 · 双击=换装 · 拖动=抓起来（松手掉到下方再继续飘）· 悬停=注视你。
const S = '/static/branding'
const V = '?v=6'
type FrameKey = 'open' | 'closed' | 'happy' | 'focused' | 'thinking' | 'sleepy' | 'wave'

const SKINS: Record<string, { label: string; frames: Record<FrameKey, string> }> = {
  chibi: {
    label: 'Q版',
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
    frames: {
      open: `${S}/doll-02.png${V}`, closed: `${S}/doll-02.png${V}`, happy: `${S}/doll-01.png${V}`,
      focused: `${S}/doll-02.png${V}`, thinking: `${S}/doll-02.png${V}`, sleepy: `${S}/doll-02.png${V}`, wave: `${S}/doll-01.png${V}`,
    },
  },
}

const LINES = ['在。有活就说。', '我盯着任务呢，跑完会汇报。', '要查什么、要写什么，直接说。', '我自己溜达一会儿，有事叫我。']
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
  const [sparks, setSparks] = useState<{ id: number; x: number; y: number }[]>([])
  const [persona, setPersona] = useState<{ name?: string; age?: number } | null>(null)
  const [line, setLine] = useState(LINES[0])
  const [busyCount, setBusyCount] = useState(0)

  const boxRef = useRef<HTMLDivElement | null>(null)
  const talkingRef = useRef(false)
  const hoverRef = useRef(false)   // 悬停时"注视"要压过眨眼/漫游的换帧（真机核对里被漫游覆盖过）
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null)
  const phys = useRef({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, falling: false, nextThink: 0, face: 1 })

  useEffect(() => { for (const s of Object.values(SKINS)) for (const src of Object.values(s.frames)) { const i = new Image(); i.src = src } }, [])
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
        }
      }
      q.x = Math.max(8, Math.min(vw() - W - 8, q.x))
      q.y = Math.max(8, Math.min(vh() - H - 8, q.y))
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
    const next = skin === 'chibi' ? 'doll' : 'chibi'
    setSkin(next)
    try { localStorage.setItem('xiaoyu_skin', next) } catch {}
    setLine(next === 'doll' ? '换好衣服了。盲盒公仔。' : '换回来了。Q版。')
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
        data-frame={frame}
        data-skin={skin}
        data-mode={mode}
        data-tasks={busyCount}
        className="xiaoyu-widget block cursor-grab active:cursor-grabbing transition-transform duration-150 hover:scale-105"
        style={{
          filter: 'drop-shadow(0 6px 14px rgba(0,0,0,.45))',
          transform: `${mode === 'roam' && pos ? `scaleX(${pos.face})` : ''} ${hover ? 'translateY(-2px)' : ''}`.trim() || undefined,
        }}
      >
        <img src={frames[frame]} alt={label} draggable={false} className="h-20 w-auto sm:h-24" />
      </button>
    </div>
  )
}
