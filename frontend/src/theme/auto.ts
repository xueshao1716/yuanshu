// ══════════════════════════════════════════════════════════
// theme/auto.ts —— 自动深色（2026-11-17）
// 三种模式：off 关（纯手动） / system 跟随系统 prefers-color-scheme / time 按时间段
// 手动覆盖：手动选主题后，本时段保持用户选择；时段/系统状态一变，自动接管
// 关键约束：自动接管只调 applyThemeVars（运行时覆盖），不写 pi_theme、不回写服务端，
//           pi_theme 始终记「用户手动选的主题」，否则自动模式会把手动选择吃掉。
// ══════════════════════════════════════════════════════════
import { applyThemeVars, currentTheme } from './apply'
import { THEME_CATALOG } from './palettes'
import { ThemeApi } from '../api'

export type AutoMode = 'off' | 'system' | 'time'
export type AutoDir = 'light' | 'dark'
export type AutoConfig = { mode: AutoMode; light: string; dark: string; from: string; to: string }

const KEY = 'pi_theme_auto'
const OV_KEY = 'pi_theme_auto_override'

export const AUTO_DEFAULT: AutoConfig = { mode: 'off', light: 'mist', dark: 'obsidian', from: '19:00', to: '07:00' }

const isThemeId = (v: unknown) => typeof v === 'string' && /^[a-z][a-z-]{0,23}$/.test(v)
const normHM = (v: unknown, fb: string) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fb)

export function normalizeAuto(o: any): AutoConfig {
  const mode: AutoMode = o && (o.mode === 'system' || o.mode === 'time') ? o.mode : 'off'
  return {
    mode,
    light: isThemeId(o?.light) ? o.light : AUTO_DEFAULT.light,
    dark: isThemeId(o?.dark) ? o.dark : AUTO_DEFAULT.dark,
    from: normHM(o?.from, AUTO_DEFAULT.from),
    to: normHM(o?.to, AUTO_DEFAULT.to),
  }
}

export function getAutoConfig(): AutoConfig {
  try { return normalizeAuto(JSON.parse(localStorage.getItem(KEY) || 'null')) } catch { return { ...AUTO_DEFAULT } }
}

function writeAuto(cfg: AutoConfig) {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)) } catch {}
}

type Override = { dir: AutoDir; natural: AutoDir } | null

function readOverride(): Override {
  try {
    const o = JSON.parse(localStorage.getItem(OV_KEY) || 'null')
    return o && (o.dir === 'light' || o.dir === 'dark') && (o.natural === 'light' || o.natural === 'dark') ? o : null
  } catch { return null }
}
function writeOverride(o: Override) {
  try { o ? localStorage.setItem(OV_KEY, JSON.stringify(o)) : localStorage.removeItem(OV_KEY) } catch {}
}

// 主题 id → 明暗方向（palettes 里浅色带 light:true，深色不带）
export function themeDir(id: string): AutoDir {
  const t: any = THEME_CATALOG.find(x => x.id === id)
  if (!t) return 'light'
  return t.light === true ? 'light' : 'dark'
}

export function hhmmToMin(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

// 深色时段 [from, to)；跨午夜（from > to）时按「到午夜 + 午夜之后」判断。
// from === to 视为「不设深色时段」，永远浅色。
export function inDarkWindow(now: Date, from: string, to: string): boolean {
  const f = hhmmToMin(from), t = hhmmToMin(to)
  if (f == null || t == null || f === t) return false
  const m = now.getHours() * 60 + now.getMinutes()
  return f < t ? m >= f && m < t : m >= f || m < t
}

// 可注入时钟：生产恒为真实时间；用例里钉住"现在几点"才能测跨时段接管。
// （2026-11-19：手动选择走事件回调、拿不到调用方传的时间，默认参数里必须能注入）
let _now: () => Date = () => new Date()
export function setAutoClock(fn?: () => Date) { _now = fn || (() => new Date()) }

function prefersDark(): boolean {
  try { return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

// 按配置算"此刻应该是亮还是暗"
export function naturalDir(cfg: AutoConfig, now = _now()): AutoDir {
  if (cfg.mode === 'system') return prefersDark() ? 'dark' : 'light'
  return inDarkWindow(now, cfg.from, cfg.to) ? 'dark' : 'light'
}

export type AutoState = { mode: AutoMode; dir: AutoDir; theme: string; overridden: boolean; cfg: AutoConfig }

// 应用一次自动决策；off 模式返回 null（表示不该接管）
export function evaluateAuto(now = _now()): AutoState | null {
  const cfg = getAutoConfig()
  if (cfg.mode === 'off') { writeOverride(null); return null }
  const natural = naturalDir(cfg, now)
  let ov = readOverride()
  if (ov && ov.natural !== natural) { ov = null; writeOverride(null) } // 时段/系统变了 → 自动接管，清覆盖
  const dir = ov ? ov.dir : natural
  const theme = dir === 'dark' ? cfg.dark : cfg.light
  const accent = currentTheme().accent
  applyThemeVars(theme, accent)
  try {
    window.dispatchEvent(new CustomEvent('pi-theme-changed', { detail: { theme, accent, auto: true, dir, overridden: !!ov } }))
  } catch {}
  return { mode: cfg.mode, dir, theme, overridden: !!ov, cfg }
}

// UI 用：当前自动状态（不应用、不产生副作用）
export function autoState(now = _now()): AutoState | null {
  const cfg = getAutoConfig()
  if (cfg.mode === 'off') return null
  const natural = naturalDir(cfg, now)
  const ov = readOverride()
  const dir = ov && ov.natural === natural ? ov.dir : natural
  return { mode: cfg.mode, dir, theme: dir === 'dark' ? cfg.dark : cfg.light, overridden: !!ov && ov.natural === natural, cfg }
}

// 改自动配置：落本地 + 同步服务端（跨端一致）+ 立即重算
export function updateAutoConfig(patch: Partial<AutoConfig>, sync = true): AutoConfig {
  const next = normalizeAuto({ ...getAutoConfig(), ...patch })
  writeAuto(next)
  writeOverride(null)
  if (sync) ThemeApi.saveAuto(next).catch(() => {})
  evaluateAuto()
  try { window.dispatchEvent(new CustomEvent('pi-theme-auto-changed', { detail: next })) } catch {}
  return next
}

// 手动选主题：记覆盖 + 把该方向的主题配对更新成用户选的这套
function onManualChoose(theme: string) {
  const cfg = getAutoConfig()
  if (cfg.mode === 'off') return
  const dir = themeDir(theme)
  const next = normalizeAuto({ ...cfg, [dir]: theme })
  writeAuto(next)
  writeOverride({ dir, natural: naturalDir(next) })
  ThemeApi.saveAuto(next).catch(() => {})
  evaluateAuto()
  try { window.dispatchEvent(new CustomEvent('pi-theme-auto-changed', { detail: next })) } catch {}
}

let _started = false
let _timer: ReturnType<typeof setInterval> | null = null

export function startThemeAuto() {
  if (typeof window === 'undefined' || _started) return
  _started = true
  evaluateAuto()
  // 跟随系统：系统切换深浅的瞬间就跟上
  try {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', () => evaluateAuto())
    else if (mq && typeof (mq as any).addListener === 'function') (mq as any).addListener(() => evaluateAuto())
  } catch {}
  // 按时间：每分钟看一次边界（跨 19:00 / 07:00 那一刻切换）
  _timer = setInterval(() => evaluateAuto(), 60_000)
  // 手动选择主题（applyTheme 广播）→ 记覆盖
  window.addEventListener('pi-theme-manual', (e: Event) => {
    const t = (e as CustomEvent).detail?.theme
    if (typeof t === 'string' && t) onManualChoose(t)
  })
  // 服务端水合到别的端的配置 → 跟随
  window.addEventListener('pi-theme-prefs-restored', (e: Event) => {
    const a = (e as CustomEvent).detail?.auto
    if (!a) return
    const next = normalizeAuto(a)
    const cur = getAutoConfig()
    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      writeAuto(next)
      writeOverride(null)
      evaluateAuto()
      try { window.dispatchEvent(new CustomEvent('pi-theme-auto-changed', { detail: next })) } catch {}
    }
  })
}

// 测试/调试用：清掉自动状态（不改配置）
export function resetAutoRuntime() {
  if (_timer) { clearInterval(_timer); _timer = null }
  _started = false
  writeOverride(null)
}
