import { useEffect, useRef, useState } from 'react'

// 小语挂件（2026-09-19 v4：透明立绘 + 换装 + 可拖动）
// 立绘：app 自己的出图通道生成 → `scripts/cutout-art.py`（纯色底 floodfill）或 rembg（渐变底）抠成透明 PNG。
// 交互：单击=说话（切帧）· 双击=换装（Q版 ⇄ 盲盒公仔）· 拖动=挪位置（位置记在 localStorage，刷新还在）。
// 动作仍是最省那档：多帧切换 + CSS 形变（呼吸/眨眼/空闲换表情/任务在跑变认真/久未交互打哈欠）。
const S = '/static/branding'
const V = '?v=5'
type FrameKey = 'open' | 'closed' | 'happy' | 'focused' | 'thinking' | 'sleepy' | 'wave'

// 两套皮肤：同一套帧名映射到不同素材，切换只换映射，不动逻辑
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
      open: `${S}/doll-02.png${V}`,
      closed: `${S}/doll-02.png${V}`,
      happy: `${S}/doll-01.png${V}`,
      focused: `${S}/doll-02.png${V}`,
      thinking: `${S}/doll-02.png${V}`,
      sleepy: `${S}/doll-02.png${V}`,
      wave: `${S}/doll-01.png${V}`,
    },
  },
}

const LINES = [
  '在。有活就说。',
  '我盯着任务呢，跑完会汇报。',
  '要查什么、要写什么，直接说。',
  '累了就歇会儿，活可以明天干。',
  '双击我换身衣服，拖我换位置。',
]
const TALK_CYCLE: FrameKey[] = ['open', 'happy', 'open', 'thinking', 'happy', 'open']
const IDLE_FACES: FrameKey[] = ['happy', 'thinking', 'sleepy', 'focused']
const IDLE_SLEEP_MS = 3 * 60 * 1000

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
  const [skin, setSkin] = useState<string>(() => {
    try { return localStorage.getItem('xiaoyu_skin') || 'chibi' } catch { return 'chibi' }
  })
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try { const raw = localStorage.getItem('xiaoyu_pos'); return raw ? JSON.parse(raw) : null } catch { return null }
  })
  const [persona, setPersona] = useState<{ name?: string; age?: number } | null>(null)
  const [line, setLine] = useState(LINES[0])
  const boxRef = useRef<HTMLDivElement | null>(null)
  const talkingRef = useRef(false)
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null)

  // 预加载两套皮肤，切装/换帧不闪白
  useEffect(() => {
    for (const s of Object.values(SKINS)) for (const src of Object.values(s.frames)) { const i = new Image(); i.src = src }
  }, [])

  useEffect(() => { const t = setTimeout(() => setFrame('open'), 1800); return () => clearTimeout(t) }, [])

  // 眨眼
  useEffect(() => {
    let t1: ReturnType<typeof setTimeout>, t2: ReturnType<typeof setTimeout>
    const loop = () => {
      t1 = setTimeout(() => {
        if (!talkingRef.current) setFrame('closed')
        t2 = setTimeout(() => { if (!talkingRef.current) setFrame('open'); loop() }, 130)
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
        if (!talkingRef.current && !open) {
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
      .then((r) => r.json())
      .then((d) => { if (alive && d?.definition) setPersona({ name: d.definition.name, age: d.definition.age }) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // 任务状态 → 表情
  const [busyCount, setBusyCount] = useState(0)
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
        else if (!busy && lastBusy.current && !talkingRef.current) {
          setFrame('happy')
          setTimeout(() => { if (!talkingRef.current) setFrame('open') }, 2500)
        }
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
    talkingRef.current = true
    let i = 0
    const timer = setInterval(() => {
      setFrame(TALK_CYCLE[i % TALK_CYCLE.length]); i++
      if (i > TALK_CYCLE.length + 1) { clearInterval(timer); talkingRef.current = false; setFrame('happy') }
    }, 180)
  }

  const switchSkin = () => {
    const next = skin === 'chibi' ? 'doll' : 'chibi'
    setSkin(next)
    try { localStorage.setItem('xiaoyu_skin', next) } catch {}
    setLine(next === 'doll' ? '换好衣服了。盲盒公仔，可爱版。' : '换回来了。Q版。')
    setOpen(true)
  }

  // 拖动：pointer 事件；位移 < 6px 视为点击（不抢单击/双击）
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
    setPos({ x: nx, y: ny })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.moved) { try { localStorage.setItem('xiaoyu_pos', JSON.stringify(pos)) } catch {} }
    else if (e.detail >= 2) switchSkin()
  }

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : {}

  return (
    <div
      ref={boxRef}
      className="fixed right-3 bottom-[calc(env(safe-area-inset-bottom,0px)+72px)] sm:bottom-6 z-[var(--pi-z-topbar)] select-none touch-none"
      style={style}
    >
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-56 panel !p-2.5 text-[12px] leading-relaxed text-pi-text" role="dialog" aria-label="小语">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-pi-dim2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {label}
            <span className="ml-auto text-[10px] text-pi-dim2">{(SKINS[skin] || SKINS.chibi).label} · 人格定义驱动</span>
          </div>
          <div>{line}</div>
        </div>
      )}
      <button
        type="button"
        aria-label={`${label}（单击说话 · 双击换装 · 可拖动）`}
        title={`${label}｜单击说话 · 双击换装 · 拖我换位置`}
        onClick={speak}
        onDoubleClick={switchSkin}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        data-frame={frame}
        data-skin={skin}
        data-tasks={busyCount}
        className="xiaoyu-widget block cursor-grab active:cursor-grabbing transition-transform duration-150 hover:scale-105"
        style={{ filter: 'drop-shadow(0 6px 14px rgba(0,0,0,.45))' }}
      >
        <img src={frames[frame]} alt={label} draggable={false} className="h-20 w-auto sm:h-24" />
      </button>
    </div>
  )
}
