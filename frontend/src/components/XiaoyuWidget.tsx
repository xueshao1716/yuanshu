import { useEffect, useMemo, useRef, useState } from 'react'

// 小语挂件（2026-09-19 v2：会动了）
// 立绘来自 记忆/人格定义.json 约束的角色设定，用 app 自己的出图通道生成（agnes-image-2.0-flash）。
// 动作全是"最省的那一档"：多帧切换 + CSS 形变，没有骨骼/建模——
// 呼吸(3.6s) + 眨眼(3.5~6s) + 空闲时偶尔换个表情(15~25s) + 点她"说话"时快速切帧 + 首次出场挥手。
const S = '/static/branding'
const FRAMES = {
  open: `${S}/xiaoyu-open.png?v=3`,
  closed: `${S}/xiaoyu-closed.png?v=3`,
  happy: `${S}/xiaoyu-happy.png?v=3`,
  focused: `${S}/xiaoyu-focused.png?v=3`,
  thinking: `${S}/xiaoyu-thinking.png?v=3`,
  sleepy: `${S}/xiaoyu-sleepy.png?v=3`,
  wave: `${S}/xiaoyu-wave.png?v=3`,
}
type FrameKey = keyof typeof FRAMES

const LINES = [
  '在。有活就说。',
  '我盯着任务呢，跑完会汇报。',
  '要查什么、要写什么，直接说。',
  '累了就歇会儿，活可以明天干。',
]
const TALK_CYCLE: FrameKey[] = ['open', 'happy', 'open', 'thinking', 'happy', 'open']
const IDLE_FACES: FrameKey[] = ['happy', 'thinking', 'sleepy', 'focused']

export default function XiaoyuWidget() {
  const [frame, setFrame] = useState<FrameKey>('wave')   // 先挥手出场
  const [open, setOpen] = useState(false)
  const [persona, setPersona] = useState<{ name?: string; age?: number } | null>(null)
  const [line, setLine] = useState(LINES[0])
  const boxRef = useRef<HTMLDivElement | null>(null)
  const talkingRef = useRef(false)

  // 预加载：免得切帧时闪空白
  useEffect(() => { for (const src of Object.values(FRAMES)) { const i = new Image(); i.src = src } }, [])

  // 出场挥手 → 回到常态
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

  // 空闲时偶尔换个表情（1.6 秒），让它看着"活着"
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

  // 名字/年龄读定义
  useEffect(() => {
    let alive = true
    fetch('/api/persona', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('yuanshu_access_token') || '') } })
      .then((r) => r.json())
      .then((d) => { if (alive && d?.definition) setPersona({ name: d.definition.name, age: d.definition.age }) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // 点外面收起气泡
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  const label = persona?.name ? `${persona.name}${persona.age ? ` · ${persona.age}岁` : ''}` : '小语'

  // 点她 → 说一句话，并且"动嘴"（快速切帧）
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

  return (
    <div ref={boxRef} className="fixed right-3 bottom-[calc(env(safe-area-inset-bottom,0px)+72px)] sm:bottom-6 z-[var(--pi-z-topbar)] select-none">
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-56 panel !p-2.5 text-[12px] leading-relaxed text-pi-text" role="dialog" aria-label="小语">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-pi-dim2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {label}
            <span className="ml-auto text-[10px] text-pi-dim2">人格定义驱动</span>
          </div>
          <div>{line}</div>
        </div>
      )}
      <button
        type="button"
        aria-label={`${label}（点一下说话）`}
        title={label}
        onClick={speak}
        data-frame={frame}
        className="xiaoyu-widget block h-14 w-14 overflow-hidden rounded-full border-2 border-pi-border bg-pi-bg2 shadow-lg transition-transform duration-150 hover:scale-105 active:scale-95"
      >
        <img src={FRAMES[frame]} alt={label} draggable={false} className="h-full w-full object-cover" />
      </button>
    </div>
  )
}
