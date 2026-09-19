import { useEffect, useRef, useState } from 'react'

// 小语挂件（2026-09-19）：右下角的她——立绘来自 app 自己的出图通道，
// 说的话受 记忆/人格定义.json 约束（名字/年龄从 /api/persona 读，语气按定义来：不套话、不滥用感叹号）。
// 动效刻意只做最省的两下：呼吸（CSS）+ 眨眼（睁眼/闭眼两张图切换）——这就是那类"娃娃"效果的全部成本。
const LINES = [
  '在。有活就说。',
  '我盯着任务呢，跑完会汇报。',
  '要查什么、要写什么，直接说。',
  '累了就歇会儿，活可以明天干。',
]

export default function XiaoyuWidget() {
  const [blink, setBlink] = useState(false)
  const [open, setOpen] = useState(false)
  const [persona, setPersona] = useState<{ name?: string; age?: number } | null>(null)
  const [line, setLine] = useState(LINES[0])
  const boxRef = useRef<HTMLDivElement | null>(null)

  // 眨眼：每 4–6 秒闭一次，闭 140ms
  useEffect(() => {
    let t1: any, t2: any
    const loop = () => {
      t1 = setTimeout(() => {
        setBlink(true)
        t2 = setTimeout(() => { setBlink(false); loop() }, 140)
      }, 4000 + Math.random() * 2000)
    }
    loop()
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  // 名字/年龄读定义（改定义，挂件跟着变）
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
        onClick={() => { setLine(LINES[Math.floor(Math.random() * LINES.length)]); setOpen((v) => !v) }}
        className="xiaoyu-widget block h-14 w-14 overflow-hidden rounded-full border-2 border-pi-border bg-pi-bg2 shadow-lg transition-transform duration-150 hover:scale-105 active:scale-95"
      >
        <img
          src={`/static/branding/xiaoyu-${blink ? 'closed' : 'open'}.png?v=2`}
          alt={label}
          draggable={false}
          className="h-full w-full object-cover"
        />
      </button>
    </div>
  )
}
