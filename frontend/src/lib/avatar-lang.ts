// avatar-lang.ts：小语全景形象（面板级）的纯函数层（2026-09-26）
// 从 工程/xiaoyu-avatar v0.2 原型移植「仪器层」语言，但按本仓数据模型重写：
//   · 原型是三态离散（idle/thinking/speaking）+ keyframes；
//   · 这里是连续 VAD 参数（lib/emotion.ts 的 MoodVisual 七参数）——刻度环没有三态模式，
//     只有「流动亮弧（速度∝tempo）+ 脉动（幅度∝energy）」的连续叠加；
//   · HUD 读数延续原型的「诚实外化」：全部是真实运行值（帧时间/内部参数/鼠标视差/状态标签）。
// 抽成纯函数是为了 Node 单测直接 import（.tsx 含 JSX 解析不了）。

/** hsl 字符串；小数裁整避免 fillStyle 解析差异 */
export function hsla(h: number, s: number, l: number, a = 1): string {
  return `hsla(${(h || 0).toFixed(1)}, ${Math.max(0, Math.min(100, s || 0)).toFixed(1)}%, ${Math.max(0, Math.min(100, l || 0)).toFixed(1)}%, ${Math.max(0, Math.min(1, a || 0)).toFixed(3)})`
}

/** 刻度环点亮：连续模式 = 一道亮弧随相位巡游（原型 idle 模式的连续化）+ 全局轻脉动 */
export function tickRingAlpha(i: number, ticks: number, head: number, energy: number, now: number): number {
  const ang = (i / ticks) * Math.PI * 2
  const diff = Math.abs(((ang - head) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI)
  const flow = Math.max(0, 1 - diff / 1.2) * 0.55 // 亮弧：距头越近越亮
  const pulse = 0.45 * (0.5 + 0.5 * Math.sin(now * 0.004 - i * 0.42)) // 脉动项（tempo 快时 now 推进快）
  return Math.max(0, Math.min(1, 0.05 + flow * (0.4 + energy * 0.6) + pulse * (0.1 + energy * 0.2)))
}

/** HUD 读数行：四角 + 两行参数。全部真实值，禁止贴图文字 */
export function readoutLines(o: {
  frameMs: number; energy: number; turbulence: number; openness: number
  v: number; a: number; d: number; stateLabel: string; mx: number; my: number
}): { id: string; pos: 'tl' | 'tr' | 'tr2' | 'bl2' | 'bl' | 'br'; text: string }[] {
  const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '0.00')
  const sig = (x: number) => `${x >= 0 ? '+' : ''}${f2(x)}`
  return [
    { id: 'sys', pos: 'tl', text: 'SYS://xiaoyu.v0.3' },
    { id: 'frame', pos: 'tr', text: `FRAME ${f2(o.frameMs)}ms` },
    { id: 'xy', pos: 'tr2', text: `X ${sig(o.mx)}  Y ${sig(o.my)}` },
    { id: 'vad', pos: 'bl2', text: `V ${sig(o.v)}  A ${sig(o.a)}  D ${sig(o.d)}` },
    { id: 'eto', pos: 'bl', text: `E ${f2(o.energy)}  T ${f2(o.turbulence)}  O ${f2(o.openness)}` },
    { id: 'state', pos: 'br', text: `STATE:${(o.stateLabel || 'IDLE').toUpperCase()}` },
  ]
}

/** 斐波那契球面粒子（均匀无极点失真）；rand 可注入保证测试确定 */
export function particleSphere(n: number, rand: () => number = Math.random): { x: number; y: number; z: number; seed: number }[] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const out: { x: number; y: number; z: number; seed: number }[] = []
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const th = golden * i
    out.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, seed: rand() * Math.PI * 2 })
  }
  return out
}

/** 星尘层：半径/透明度/角速三档随机，越大越慢造远景视差 */
export function dustField(n: number, rand: () => number = Math.random): { a: number; r: number; o: number; v: number }[] {
  const out: { a: number; r: number; o: number; v: number }[] = []
  for (let i = 0; i < n; i++) {
    out.push({ a: rand() * Math.PI * 2, r: 0.42 + rand() * 0.75, o: 0.06 + rand() * 0.22, v: 6 + rand() * 26 })
  }
  return out
}
