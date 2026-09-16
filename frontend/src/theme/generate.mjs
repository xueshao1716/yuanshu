// ══════════════════════════════════════════════════════════
// 元枢 Token 生成器（Ant Design 路线：主题是纯函数，不是表）
// seed(设计意图) → 派生算法 → 全量 CSS 变量
// 跑法：node scripts/generate-theme.mjs（写回 styles.css 标记区块）
// 校验：node --test tests/design-contract.test.mjs（派生不变量）
// ══════════════════════════════════════════════════════════

// ── 色彩数学：sRGB ↔ OKLCH（Björn Ottosson 的 OKLab 标准）──
const hexToRgb = hex => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
}
const rgbToHex = rgb => '#' + rgb.map(c =>
  Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')
const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const gam = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function rgbToOklch(rgb) {
  const [r, g, b] = rgb.map(lin)
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  return { L, C: Math.hypot(A, B), H: Math.atan2(B, A) }
}
function oklchToRgb({ L, C, H }) {
  const A = C * Math.cos(H), B = C * Math.sin(H)
  const l_ = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m_ = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s_ = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map(gam)
}
// 色域内收敛：超出色域就降 chroma（简单二分，够用）
function safeOklch(lch) {
  let { C } = lch, lo = 0, hi = C
  const inGamut = c => { const r = oklchToRgb({ ...lch, C: c }); return r.every(v => v >= -0.0005 && v <= 1.0005) }
  if (!inGamut(C)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(mid)) lo = mid; else hi = mid
    }
    C = lo
  }
  return { ...lch, C }
}
const setL = (hex, L) => safeOklch({ ...rgbToOklch(hexToRgb(hex)), L })
const shiftL = (hex, dL) => { const c = rgbToOklch(hexToRgb(hex)); return rgbToHex(oklchToRgb(safeOklch({ ...c, L: Math.max(0, Math.min(1, c.L + dL)) }))) }
const mixAlpha = (hex, a) => { const [r, g, b] = hexToRgb(hex).map(c => Math.round(c * 255)); return `rgba(${r},${g},${b},${a})` }

// WCAG 亮度/对比度
export const wcagLum = hex => { const [r, g, b] = hexToRgb(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
export function contrast(fg, bg) {
  const [x, y] = [wcagLum(fg), wcagLum(bg)].sort((a, b) => b - a)
  return (x + 0.05) / (y + 0.05)
}
// 保持色相与彩度，解出对 bg 达到目标对比度的 L
function solveLForContrast(baseHex, bgHex, target) {
  const ch = rgbToOklch(hexToRgb(baseHex))
  const dir = wcagLum(bgHex) > 0.18 ? -1 : 1 // 浅底往深解、深底往浅解
  let lo = 0, hi = 1
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2
    const candidate = rgbToHex(oklchToRgb(safeOklch({ ...ch, L: mid })))
    const cr = contrast(candidate, bgHex)
    if (cr < target) { if (dir > 0) lo = mid; else hi = mid } else { if (dir > 0) hi = mid; else lo = mid }
  }
  const L = (lo + hi) / 2
  let out = rgbToHex(oklchToRgb(safeOklch({ ...ch, L })))
  // 二分收敛在中点，可能刚好差一点点（实测会落在 3.17 / 4.49 这种"看着达标其实没有"的值）。
  // 定稿前按目标方向再走几步——这里是保底，不是"差不多"。
  for (let i = 0; i < 40 && contrast(out, bgHex) < target; i++) {
    const stepped = Math.max(0, Math.min(1, L + (dir > 0 ? 0.002 * (i + 1) : -0.002 * (i + 1))))
    out = rgbToHex(oklchToRgb(safeOklch({ ...ch, L: stepped })))
  }
  return out
}
// 不够读就按对比度解一个够读的回来（保持色相/彩度），够读就原样返回。
// 越界（解不出来）时取二分的中点，也不至于把颜色搞成纯黑纯白。
function legibleOn(hex, bgHex, target) {
  return contrast(hex, bgHex) >= target ? hex : solveLForContrast(hex, bgHex, target)
}
// 半透明色叠在底色上之后是什么颜色（组件的"软底"都这么算出来）
function blendHex(fgHex, alpha, bgHex) {
  const fg = hexToRgb(fgHex).map(c => c * 255)
  const bg = hexToRgb(bgHex).map(c => c * 255)
  return rgbToHex(fg.map((c, i) => (c * alpha + bg[i] * (1 - alpha)) / 255))
}

// ── Seed：每套主题只有这几个设计意图输入 ──
export const SEEDS = {
  // 新增：高亮低饱和（默认主题，基于 RuiRui 研究报告）
  highLum: { bg: '#f5f6f8', text: '#2f3542', accent: '#5b7fb8', light: true, step: 0.012,
            overrides: {
              '--pi-accent2': '#7a9acc',
              '--pi-accent-deep': '#4a6a9a',
              '--pi-accent-glow': 'rgba(91,127,184,0.12)',
              '--pi-green': '#5a9a7a',
              '--pi-red': '#c25d5d',
              '--pi-yellow': '#b8935a',
              '--pi-border-hi': 'rgba(0,0,0,0.04)',
              '--pi-shadow-sm': '0 1px 2px rgba(0,0,0,.04), 0 1px 4px rgba(0,0,0,.04)',
              '--pi-shadow-md': '0 2px 8px rgba(0,0,0,.06), 0 1px 3px rgba(0,0,0,.04)',
              '--pi-shadow-lg': '0 4px 16px rgba(0,0,0,.08), 0 2px 6px rgba(0,0,0,.04)',
            } },
  deep:   { bg: '#0e1116', text: '#e8eef8', accent: '#5468ff', step: 0.043 },
  ink:    { bg: '#050508', text: '#eceef2', accent: '#5468ff', step: 0.045,
            overrides: { '--pi-accent-glow': 'rgba(120,120,160,0.22)', '--pi-glow-purple': 'rgba(120,120,160,0.12)', '--pi-glow-cyan': 'rgba(100,140,180,0.06)' } },
  violet: { bg: '#0a0818', text: '#f0eaff', accent: '#8b7cf6', step: 0.045,
            overrides: { '--pi-accent-glow': 'rgba(139,92,246,0.32)', '--pi-accent2': '#a78bfa', '--pi-accent-deep': '#6d5bd0', '--pi-glow-purple': 'rgba(139,92,246,0.22)', '--pi-glow-cyan': 'rgba(120,100,200,0.08)' } },
  mist:   { bg: '#fdfdfd', text: '#23252a', accent: '#4356b8', light: true, step: 0.012,
            overrides: { '--pi-dim': '#62656b', '--pi-dim2': '#696c72', '--pi-green': '#21834c', '--pi-red': '#c4413b', '--pi-yellow': '#a36513', '--pi-accent-glow': 'rgba(67,86,184,0.10)', '--pi-glow-purple': 'transparent', '--pi-glow-cyan': 'transparent' } },
  kraft:  { bg: '#e5d4aa', text: '#3b2c14', accent: '#b45309', light: true, step: 0.035,
            overrides: {
              '--pi-green': '#158039', '--pi-red': '#bb2c27', '--pi-yellow': '#a16207',
              '--pi-accent2': '#d97706', '--pi-accent-deep': '#8f3f00',
              '--pi-accent-glow': 'rgba(180,83,9,0.16)',
              '--pi-glow-purple': 'rgba(146,98,10,0.07)', '--pi-glow-cyan': 'rgba(120,90,20,0.05)',
              '--pi-border-hi': 'rgba(92,58,16,0.10)',
              '--pi-shadow-sm': '0 1px 2px rgba(92,58,16,.16), 0 1px 0 rgba(255,244,214,.28)',
              '--pi-shadow-md': '0 3px 8px rgba(92,58,16,.20), 0 1px 0 rgba(255,244,214,.22)',
              '--pi-shadow-lg': '0 8px 18px rgba(80,50,12,.24), 0 1px 0 rgba(255,244,214,.18)',
              '--pi-font-display': '"Iowan Old Style","Palatino Linotype","Songti SC","STSong",serif',
            } },
  // 08-29 主题系统专门页新增（threeui 色板气质：sepia/moss/azure）
  sepia:  { bg: '#171310', text: '#ede4d8', accent: '#d97706', step: 0.042,
            overrides: { '--pi-green': '#5fae6e', '--pi-red': '#e06c5f', '--pi-yellow': '#d9a441',
                         '--pi-accent-glow': 'rgba(217,119,6,0.26)', '--pi-glow-purple': 'rgba(180,130,60,0.10)', '--pi-glow-cyan': 'rgba(150,120,60,0.05)',
                         '--pi-shadow-sm': 'rgba(20,12,4,0.22)', '--pi-shadow-md': 'rgba(20,12,4,0.30)', '--pi-shadow-lg': 'rgba(16,10,2,0.40)' } },
  moss:   { bg: '#0c120e', text: '#e2ece4', accent: '#3f9e6e', step: 0.040,
            overrides: { '--pi-green': '#4ade80', '--pi-red': '#e07a6c', '--pi-yellow': '#d9b259',
                         '--pi-accent-glow': 'rgba(63,158,110,0.28)', '--pi-glow-purple': 'rgba(90,140,110,0.10)', '--pi-glow-cyan': 'rgba(80,150,120,0.06)' } },
  azure:  { bg: '#0a101c', text: '#e0eaff', accent: '#38bdf8', step: 0.041,
            overrides: { '--pi-accent2': '#7dd3fc', '--pi-accent-deep': '#0284c7', '--pi-accent-glow': 'rgba(56,189,248,0.30)', '--pi-glow-purple': 'rgba(80,120,200,0.12)', '--pi-glow-cyan': 'rgba(56,189,248,0.10)' } },
  // 中式水墨（09-03）：宣纸底 + 墨分五色灰阶 + 朱砂唯一强调；楷体 + 宣纸纹理见 styles.css 手写特化区
  shuimo: { bg: '#F7F4EC', text: '#2A2620', accent: '#B54334', light: true, step: 0.030,
            overrides: {
              '--pi-green': '#4A7A5A', '--pi-red': '#A8382B', '--pi-yellow': '#B08A3E',
              '--pi-accent2': '#C65A48', '--pi-accent-deep': '#8E3428',
              '--pi-accent-glow': 'rgba(181,67,52,0.10)',
              '--pi-glow-purple': 'rgba(90,110,130,0.05)', '--pi-glow-cyan': 'rgba(62,92,107,0.05)',
              '--pi-border-hi': 'rgba(58,52,40,0.06)',
              '--pi-shadow-sm': '0 1px 2px rgba(58,52,40,.06), 0 1px 4px rgba(58,52,40,.05)',
              '--pi-shadow-md': '0 2px 8px rgba(58,52,40,.08), 0 1px 3px rgba(58,52,40,.05)',
              '--pi-shadow-lg': '0 4px 16px rgba(58,52,40,.10), 0 2px 6px rgba(58,52,40,.06)',
              '--pi-font-sans': '"Ma Shan Zheng","LXGW WenKai Screen","LXGW WenKai","Kaiti SC","STKaiti","KaiTi",serif',
              '--pi-font-display': '"Ma Shan Zheng","LXGW WenKai Screen","LXGW WenKai","Kaiti SC","STKaiti","KaiTi",serif',
            } },
  // 竹影（09-03）：浅色自然绿——晨竹米白底 + 竹青主色 + 全绿化光斑
  bamboo: { bg: '#F1F5EC', text: '#233024', accent: '#3F7A50', light: true, step: 0.032,
            overrides: {
              '--pi-green': '#2F7A4E', '--pi-red': '#B5504A', '--pi-yellow': '#A98B3D',
              '--pi-accent2': '#5C9970', '--pi-accent-deep': '#2F6340',
              '--pi-accent-glow': 'rgba(63,122,80,0.12)',
              '--pi-glow-purple': 'rgba(110,140,90,0.06)', '--pi-glow-cyan': 'rgba(90,150,120,0.06)',
              '--pi-border-hi': 'rgba(40,60,40,0.06)',
              '--pi-shadow-sm': '0 1px 2px rgba(35,60,42,.06), 0 1px 4px rgba(35,60,42,.05)',
              '--pi-shadow-md': '0 2px 8px rgba(35,60,42,.08), 0 1px 3px rgba(35,60,42,.05)',
              '--pi-shadow-lg': '0 4px 16px rgba(35,60,42,.10), 0 2px 6px rgba(35,60,42,.06)',
            } },
  // 拟态木（09-04）：枫木台面 + 翠绿镶嵌。木纹/斜面见 styles.css 手写特化区
  // 2026-09-16：主色从 #0B8A54 压深到 #007d4b——同一个绿在枫木底（#ddc9a8）上只有 2.72，
  // 而主色到处被当**文字**用（芯片、链接、状态），2.72 就是"看得见但费劲"。
  wood: { bg: '#E8D4B2', text: '#2A2118', accent: '#007d4b', light: true, step: 0.033,
            overrides: {
              '--pi-green': '#0B8A54', '--pi-red': '#B24A3A', '--pi-yellow': '#C4A046',
              '--pi-accent2': '#2BB56E', '--pi-accent-deep': '#086B42',
              '--pi-accent-glow': 'rgba(11,138,84,0.16)',
              '--pi-glow-purple': 'rgba(140,90,40,0.06)', '--pi-glow-cyan': 'rgba(11,138,84,0.06)',
              '--pi-border-hi': 'rgba(70,42,16,0.08)',
              '--pi-shadow-sm': '0 1px 2px rgba(62,38,12,.14), 0 1px 0 rgba(255,244,220,.35)',
              '--pi-shadow-md': '0 3px 8px rgba(62,38,12,.18), inset 0 1px 0 rgba(255,246,228,.4)',
              '--pi-shadow-lg': '0 8px 20px rgba(50,30,10,.22), inset 0 1px 0 rgba(255,246,228,.35)',
              '--pi-font-display': '"Palatino Linotype","Songti SC","STSong","SimSun",serif',
            } },
  // 液态玻璃（09-11）：Apple 风格的浅色半透明界面，冷蓝紫光晕与高光边缘。
  // 实底 token 保证阅读性，透明质感由 styles.css 的组件特化层统一叠加。
  'liquid-glass': { bg: '#EEF4FB', text: '#1B2433', accent: '#4778D6', light: true, step: 0.018,
                    overrides: {
                      '--pi-accent2': '#6E9AF0', '--pi-accent-deep': '#315EBA',
                      '--pi-green': '#2F9B73', '--pi-red': '#C85C70', '--pi-yellow': '#B9822D',
                      '--pi-accent-glow': 'rgba(71,120,214,0.18)',
                      '--pi-glow-purple': 'rgba(126,107,224,0.13)', '--pi-glow-cyan': 'rgba(73,174,220,0.16)',
                      '--pi-border-hi': 'rgba(255,255,255,0.72)',
                      '--pi-shadow-sm': '0 1px 2px rgba(37,62,103,.08), 0 3px 10px rgba(37,62,103,.06)',
                      '--pi-shadow-md': '0 5px 18px rgba(37,62,103,.11), 0 1px 3px rgba(37,62,103,.06)',
                      '--pi-shadow-lg': '0 18px 45px rgba(37,62,103,.16), 0 3px 12px rgba(37,62,103,.08)',
                      '--pi-glass-bg': 'rgba(255,255,255,0.58)',
                      '--pi-glass-border': 'rgba(255,255,255,0.70)',
                      '--pi-font-display': '"SF Pro Display","Inter","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif',
                    } },
}

const SEMANTIC = { green: '#3ecf8e', red: '#f47067', yellow: '#f5b759' }
const FONTS = {
  mono: '"Cascadia Code", "JetBrains Mono", Consolas, "SF Mono", monospace',
  sans: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  display: '"Space Grotesk", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
}
const FONT_SCALE = [['badge', 10], ['xs', 11], ['sm', 12], ['md', 13], ['lg', 15], ['xl', 17], ['xxl', 22]] // 行高绑定：(n+4)/n，7 级字阶白名单
export const EASINGS = {
  '--pi-ease': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  '--pi-ease-sheet': 'cubic-bezier(0.32, 0.72, 0, 1)',
}

// ── 全局（非主题）token：间距 + 层叠 z-index（08-26 收口：从手写区挪进生成器，消除多源漂移）──
// 不随主题变，统一在 :root 输出；组件只能用这里定义的 --pi-space-* / --pi-z-*
export const SPACING = [['xs', 4], ['sm', 8], ['md', 12], ['lg', 16], ['xl', 20], ['xxl', 24], ['xxxl', 32]]
export const Z_INDEX = [
  ['topbar', 60], ['rightpanel', 80], ['dialog', 100], ['dialog-top', 101], ['toast', 100], ['palette', 110],
  ['palette-content', 111], ['viewer', 120], ['modal', 200], ['modal-inner', 201],
]
export function globalVars() {
  const out = {}
  for (const [k, v] of SPACING) out[`--pi-space-${k}`] = `${v}px`
  for (const [k, v] of Z_INDEX) out[`--pi-z-${k}`] = v
  return out
}

// ── 派生算法：seed → 全量变量 ──
export function generateTheme(seed) {
  const v = {}
  const bgL = rgbToOklch(hexToRgb(seed.bg)).L
  // 阶梯方向：深色主题向上加亮、浅色主题向下加深（"更高级"的语义一致，物理方向相反）
  const dir = seed.light ? -1 : 1
  const st = (seed.step ?? 0.043) * dir

  // 底色五级阶梯：同色相同彩度，L 线性移动（层级关系由亮度差表达——antd dark 同理）
  v['--pi-bg'] = seed.bg
  ;[1, 2, 3, 4].forEach(i => { v[`--pi-bg${i}`] = rgbToHex(oklchToRgb(setL(seed.bg, bgL + st * i))) })
  v['--pi-bg-hover'] = rgbToHex(oklchToRgb(setL(seed.bg, bgL + st * 1.6)))
  v['--pi-bg-active'] = rgbToHex(oklchToRgb(setL(seed.bg, bgL + st * 2.3)))

  const bg2 = v['--pi-bg2']
  // 边框 = 底色按固定亮度差偏移；soft 更贴近底色
  v['--pi-border'] = rgbToHex(oklchToRgb(setL(seed.bg, bgL + st * 2.6)))
  v['--pi-border-soft'] = rgbToHex(oklchToRgb(setL(seed.bg, bgL + st * 1.35)))
  v['--pi-border-hi'] = seed.light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.10)'

  // 文字三级：text 本体；dim/dim2 保持文字色相、彩度给下限（纯灰在玻璃上显脏），按目标对比度解 L
  v['--pi-text'] = seed.text
  const dimBase = (() => {
    const ch = rgbToOklch(hexToRgb(seed.text))
    const C = Math.min(0.045, Math.max(0.02, ch.C * 3))
    return rgbToHex(oklchToRgb(safeOklch({ L: ch.L, C, H: ch.H })))
  })()
  v['--pi-dim'] = solveLForContrast(dimBase, seed.bg, 6.0)
  // dim2 要在它出现的亮承载面（卡片 bg2 / 按钮 bg3=default）上≥4.8：用最亮的 bg3 求解，
  // 否则暗背景下对 bg3/default 会漏到 ~4.2（复评检测器抓到 4.30，此前只对 bg2 求解覆盖不全）
  v['--pi-dim2'] = solveLForContrast(dimBase, v['--pi-bg3'], 4.8)

  // 强调色族：accent2/accent-deep 是 accent 的亮度位移（换主色后交互态永远协调）
  v['--pi-accent'] = seed.accent
  v['--pi-on-accent'] = contrast('#ffffff', seed.accent) >= contrast('#000000', seed.accent) ? '#ffffff' : '#000000'
  v['--pi-accent2'] = seed.overrides?.['--pi-accent2'] || shiftL(seed.accent, 0.09)
  v['--pi-accent-deep'] = seed.overrides?.['--pi-accent-deep'] || shiftL(seed.accent, -0.09)
  v['--pi-accent-glow'] = seed.overrides?.['--pi-accent-glow'] || mixAlpha(seed.accent, 0.35)
  v['--pi-glow'] = v['--pi-accent-glow']

  // 语义色 + 装饰光斑（overrides 可覆写）
  Object.assign(v, {
    '--pi-green': SEMANTIC.green, '--pi-red': SEMANTIC.red, '--pi-yellow': SEMANTIC.yellow,
    '--pi-glow-purple': 'rgba(139,92,246,0.18)', '--pi-glow-cyan': 'rgba(56,189,248,0.10)',
  }, seed.overrides || {})

  // ── 语义色的可读性兜底（2026-09-16）──
  // 这三个色会被当**文字/图标**画在面板上（bg1）：只按"好看"选色会出现
  // wood 的警告色对比度 1.54（几乎看不见）、highLum 2.55、水墨/竹影 2.67。
  // 这里保持色相彩度，只把明度解到面板上够读；本来就够读的原样不动。
  for (const key of ['--pi-green', '--pi-red', '--pi-yellow']) {
    if (/^#[0-9a-f]{6}$/i.test(v[key])) v[key] = legibleOn(v[key], v['--pi-bg1'], 3.2)
  }
  // 语义色**当底**时的前景（步骤条上的对勾、状态芯片）：和 on-accent 同一套规则——
  // 白字还是黑字，取对比度高的那个。写死 text-white 在亮绿底上只有 1.9（等于没有字）。
  for (const key of ['green', 'red', 'yellow']) {
    const c = v[`--pi-${key}`]
    if (/^#[0-9a-f]{6}$/i.test(c)) v[`--pi-on-${key}`] = contrast('#ffffff', c) >= contrast('#000000', c) ? '#ffffff' : '#000000'
  }

  // ── 语义层级 token（HeroUI surface/overlay/field 三层体系）──
  // surface: 抬起的面板（如卡片、侧边栏行）
  v['--pi-surface'] = v['--pi-bg1']
  v['--pi-surface-fg'] = seed.text
  // overlay: 弹出层（菜单、下拉、弹窗）
  v['--pi-overlay'] = v['--pi-bg2']
  v['--pi-overlay-fg'] = v['--pi-dim']
  // field: 输入框/选择器背景
  v['--pi-field'] = v['--pi-bg1']
  v['--pi-field-border'] = v['--pi-border-soft']
  // default: 不活跃/默认态按钮背景
  v['--pi-default'] = v['--pi-bg3']
  // 语义状态色（alias 便于语义引用）
  v['--pi-success'] = v['--pi-green']
  v['--pi-warning'] = v['--pi-yellow']
  v['--pi-danger'] = v['--pi-red']
  // accent soft 背景（组件用）
  v['--pi-accent-soft'] = mixAlpha(seed.accent, 0.12)
  // accent 当**文字**画在 accent-soft 上时（badge、状态芯片）只有 ~3.2：
  // soft 底是"accent 12% 叠在 bg1 上"，所以按真实叠出来的那个色解对比度，
  // 而不是拿 accent 跟 bg1 比（那会算出一个不存在的读数）。
  v['--pi-accent-soft-fg'] = legibleOn(seed.accent, blendHex(seed.accent, 0.12, v['--pi-bg1']), 4.5)

  // 三档阴影 token（08-26 立体感体系）：组件类只引用变量，主题可覆写浓淡与色调
  const shadowTint = seed.light ? 'rgba(15,23,42,' : 'rgba(0,0,0,'
  v['--pi-shadow-sm'] = seed.overrides?.['--pi-shadow-sm'] || `${shadowTint}0.18)`
  v['--pi-shadow-md'] = seed.overrides?.['--pi-shadow-md'] || `${shadowTint}0.26)`
  v['--pi-shadow-lg'] = seed.overrides?.['--pi-shadow-lg'] || `${shadowTint}0.34)`

  // 字体 / 圆角（单变量派生）/ 字阶（行高绑定单 token）
  v['--pi-font-mono'] = seed.overrides?.['--pi-font-mono'] || FONTS.mono
  v['--pi-font-sans'] = seed.overrides?.['--pi-font-sans'] || FONTS.sans
  v['--pi-font-display'] = seed.overrides?.['--pi-font-display'] || FONTS.display
  // 08-26 去 AI 味：圆角全档收敛（工具感），与 styles.css 手改保持一致
  v['--pi-radius-base'] = '6px'
  v['--pi-r-sm'] = '4px'; v['--pi-r-md'] = '6px'; v['--pi-r-lg'] = '8px'; v['--pi-r-xl'] = '12px'
  for (const [name, px] of FONT_SCALE) {
    v[`--pi-fs-${name}`] = `${px}px`
    v[`--pi-lh-${name}`] = `${((px + 4) / px).toFixed(3)}`
  }

  // ── 08-26 主题穿透到组件层：accent 交互矩阵 + 渐变 + 组件语义 + 图表色 ──
  // 组件类一律引用这些变量（勿再写死 rgba/hex），主题一变全跟随
  v['--pi-accent-hover'] = seed.overrides?.['--pi-accent-hover'] || shiftL(seed.accent, 0.06)
  v['--pi-accent-active'] = seed.overrides?.['--pi-accent-active'] || shiftL(seed.accent, -0.04)
  v['--pi-accent-muted'] = seed.overrides?.['--pi-accent-muted'] || mixAlpha(seed.accent, 0.55)
  v['--pi-grad-accent'] = seed.overrides?.['--pi-grad-accent'] || `linear-gradient(135deg, ${v['--pi-accent']} 0%, ${v['--pi-accent2']} 100%)`
  v['--pi-grad-glow'] = seed.overrides?.['--pi-grad-glow'] || `linear-gradient(135deg, ${v['--pi-accent']} 0%, transparent 70%)`

  v['--pi-btn-bg'] = v['--pi-default']
  v['--pi-btn-border'] = v['--pi-border']
  v['--pi-btn-hover'] = v['--pi-bg-hover']
  v['--pi-card-bg'] = v['--pi-bg1']
  v['--pi-card-border'] = v['--pi-border']
  v['--pi-input-bg'] = v['--pi-field']
  v['--pi-input-border'] = v['--pi-field-border']

  // ── P1 组件级语义 token（08-27）：panel/dialog/badge/glass/info，主题穿透到组件层 ──
  v['--pi-panel-bg'] = v['--pi-bg1']
  v['--pi-panel-border'] = v['--pi-border']
  v['--pi-dialog-bg'] = v['--pi-bg2']
  v['--pi-dialog-border'] = v['--pi-border']
  v['--pi-badge-bg'] = v['--pi-accent-soft']
  v['--pi-badge-fg'] = v['--pi-accent-soft-fg']
  v['--pi-badge-border'] = 'transparent'
  v['--pi-glass-bg'] = seed.light ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.06)'
  v['--pi-glass-border'] = seed.light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)'
  v['--pi-info'] = '#3b82f6'
  v['--pi-info-fg'] = '#ffffff'
  v['--pi-muted'] = solveLForContrast(dimBase, seed.bg, 3.2)

  // 图表/序列色（高区分度，固定；主题 only 影响可读性不重映射）
  const CHART = ['#5470f7', '#23c399', '#f0b64a', '#2fb4d6', '#b06cf2']
  CHART.forEach((c, i) => { v[`--pi-chart-${i + 1}`] = c })
  return v
}

// 动效 token（全主题共享，两条曲线白名单的源头）
export function motionVars() {
  return {
    ...EASINGS,
    '--pi-motion-fast': '.14s var(--pi-ease)',
    '--pi-motion-base': '.2s var(--pi-ease)',
    '--pi-motion-slow': '.3s var(--pi-ease-sheet)',
  }
}

const fmtVars = vars => Object.entries(vars).map(([k, val]) => `  ${k}: ${val};`).join('\n')

// 输出两段 CSS：:root 区（deep + 共享动效）与三套 data-theme 区
export function emitCss() {
  const deep = { ...generateTheme(SEEDS.deep), ...motionVars(), ...globalVars() }
  const block = (sel, vars) => `${sel} {\n${fmtVars(vars)}\n}`
  return {
    root: block(':root', deep),
    themes: ['ink', 'violet', 'mist', 'kraft', 'shuimo', 'bamboo', 'wood', 'liquid-glass'].map(name =>
      block(`[data-theme="${name}"]`, generateTheme(SEEDS[name]))).join('\n'),
  }
}
