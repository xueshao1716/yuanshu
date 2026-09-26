// MoodPanel / XiaoyuAvatar 测试（2026-09-26）
// 纯函数层 avatar-lang.ts 可直接 import 单测；两个 .tsx 组件走源码契约断言
// （同 mood-orb 先例：Node 不解析 JSX）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hsla, tickRingAlpha, readoutLines, particleSphere, dustField } from '../../frontend/src/lib/avatar-lang.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFileSync(join(ROOT, 'frontend', 'src', ...p), 'utf8')

test('hsla：小数裁整 + 分量钳制，输出合法 hsla 字符串', () => {
  assert.equal(hsla(262.44, 70, 60, 0.5), 'hsla(262.4, 70.0%, 60.0%, 0.500)')
  assert.equal(hsla(-5, -20, 200, 2), 'hsla(-5.0, 0.0%, 100.0%, 1.000)')
  assert.ok(/^hsla\([0-9.-]+, [0-9.]+%, [0-9.]+%, [0-9.]+\)$/.test(hsla(38, 88, 62, 0.3)))
})

test('tickRingAlpha：连续模式有界、亮弧在头部、能量放大亮度', () => {
  const ticks = 72, head = 1.0, now = 500
  let min = 1, max = 0
  const alphas = []
  for (let i = 0; i < ticks; i++) {
    const a = tickRingAlpha(i, ticks, head, 0.5, now)
    alphas.push(a)
    min = Math.min(min, a); max = Math.max(max, a)
  }
  assert.ok(min >= 0 && max <= 1, `有界 [0,1]，实得 [${min}, ${max}]`)
  // 头部对应段（ang≈head）应显著高于对侧
  const atHead = alphas[Math.round(head / (Math.PI * 2) * ticks) % ticks]
  const atTail = alphas[Math.round(((head + Math.PI) % (Math.PI * 2)) / (Math.PI * 2) * ticks) % ticks]
  assert.ok(atHead > atTail + 0.1, `亮弧应在头部更亮：head=${atHead.toFixed(3)} tail=${atTail.toFixed(3)}`)
  const lowE = tickRingAlpha(Math.round(head / (Math.PI * 2) * ticks) % ticks, ticks, head, 0.1, now)
  const highE = tickRingAlpha(Math.round(head / (Math.PI * 2) * ticks) % ticks, ticks, head, 1, now)
  assert.ok(highE > lowE, `energy↑ 亮度↑：${highE.toFixed(3)} > ${lowE.toFixed(3)}`)
})

test('particleSphere：220 点单位球面均匀分布、可注入随机源保证确定', () => {
  const pts = particleSphere(220, () => 0.5)
  assert.equal(pts.length, 220)
  for (const p of pts) {
    assert.ok(Math.abs(Math.hypot(p.x, p.y, p.z) - 1) < 1e-9, '单位球面')
    assert.ok(Number.isFinite(p.seed), 'seed 有限')
  }
  // 斐波那契：相邻点天顶角均匀（y 等差）
  const dy = Math.abs(pts[1].y - pts[0].y - (pts[2].y - pts[1].y))
  assert.ok(dy < 1e-9, 'y 等差=均匀纬向分布')
  assert.equal(JSON.stringify(particleSphere(5, () => 0.3)), JSON.stringify(particleSphere(5, () => 0.3)), '同随机源同结果')
})

test('dustField：半径/透明度/角速在原型量级', () => {
  const d = dustField(90, () => 0.42)
  assert.equal(d.length, 90)
  for (const x of d) {
    assert.ok(x.r >= 0.42 && x.r <= 1.17 && x.o >= 0.06 && x.o <= 0.28 && x.v >= 6 && x.v <= 32)
  }
})

test('readoutLines：六行真实读数，字段/格式/位置齐全', () => {
  const lines = readoutLines({ frameMs: 16.71, energy: 0.62, turbulence: 0.31, openness: 0.7, v: 0.2, a: -0.1, d: 0.55, stateLabel: '好奇', mx: -0.12, my: 0.3 })
  assert.equal(lines.length, 6)
  const by = Object.fromEntries(lines.map(l => [l.id, l]))
  assert.ok(by.frame.text.startsWith('FRAME ') && by.frame.text.endsWith('ms'), by.frame.text)
  assert.ok(/^E [0-9]\.[0-9][0-9] {2}T [0-9]\.[0-9][0-9] {2}O [0-9]\.[0-9][0-9]$/.test(by.eto.text), by.eto.text)
  assert.ok(/^V \+0\.20 {2}A -0\.10 {2}D \+0\.55$/.test(by.vad.text), by.vad.text)
  assert.equal(by.state.text, 'STATE:好奇'.toUpperCase() === by.state.text ? by.state.text : '')
  assert.equal(by.state.text, 'STATE:好奇')
  assert.ok(/^X -0\.1[0-9] {2}Y \+0\.3[0-9]$/.test(by.xy.text), by.xy.text)
  assert.ok(by.sys.text.includes('xiaoyu'))
  assert.deepEqual(lines.map(l => l.pos).sort(), ['bl', 'bl2', 'br', 'tl', 'tr', 'tr2'])
})

test('readoutLines：NaN/缺值回落 0.00，不输出 NaN 读数', () => {
  const lines = readoutLines({ frameMs: NaN, energy: NaN, turbulence: NaN, openness: NaN, v: NaN, a: NaN, d: NaN, stateLabel: '', mx: NaN, my: NaN })
  for (const l of lines) assert.ok(!l.text.includes('NaN'), `${l.id} 不应含 NaN：${l.text}`)
  assert.equal(lines[4].text, 'E 0.00  T 0.00  O 0.00')
})

test('源码契约：XiaoyuAvatar 保留原型视觉语言与工程护栏', () => {
  const src = read('components', 'XiaoyuAvatar.tsx')
  for (const needle of [
    "particleSphere(N)", "dustField(DUST)", "tickRingAlpha(i, TICKS, head, energy, now)",
    "readoutLines(", "const N = 220", "const DUST = 90", "const TICKS = 72", "SCAN_PERIOD = 6.0",
    "Math.min(window.devicePixelRatio || 1, 2)", "DT_MAX", "visibilitychange",
    "prefers-reduced-motion", "ResizeObserver", "role=\"img\"",
  ]) assert.ok(src.includes(needle), `XiaoyuAvatar 应含 ${needle}`)
  assert.ok(!/fetch\(|axios/.test(src), '形象组件不自己发请求')
  // effect 依赖不含 state：SWR 轮询新对象不得重建画布
  const dep = src.slice(src.lastIndexOf('}, [])'))
  assert.ok(src.includes('}, [])'), '渲染 effect 依赖应为空数组')
  assert.ok(!/\[state\]|\[state, label\]/.test(src), 'state/label 不得进渲染 effect 依赖')
})

test('源码契约：MoodPanel 弹层交互与数据边界', () => {
  const src = read('components', 'MoodPanel.tsx')
  for (const needle of [
    "<dialog", "el.showModal()", "onCancel=", "document.body.style.overflow",
    "e.target !== e.currentTarget", "previous?.focus", "<PortraitState action={action}",
    "{open &&", "aria-label=\"关闭形象面板\"",
  ]) assert.ok(src.includes(needle), `MoodPanel 应含 ${needle}`)
  assert.ok(!/fetch\(|EmotionApi/.test(src), '面板不自己拉情绪数据，props 注入')
})

test('源码契约：ChatArea 灵珠可点且只读展示', () => {
  const src = read('components', 'ChatArea.tsx')
  for (const needle of [
    "aria-expanded={orbPanelOpen}", "setOrbPanelOpen(true)", "<MoodPanel open={orbPanelOpen}",
    "<button type=\"button\"", "emotion={companionEmotion}", "action={companion.action}",
  ]) assert.ok(src.includes(needle), `ChatArea 应含 ${needle}`)
})
