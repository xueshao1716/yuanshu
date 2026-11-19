import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const CATALOG = [
  { id: 'mist', light: true },
  { id: 'shuimo', light: true },
  { id: 'obsidian' },
  { id: 'qiaojian' },
]

function load() {
  const saved = new Map()
  const applied = []
  const exported = {}
  const localStorage = {
    getItem: k => (saved.has(k) ? saved.get(k) : null),
    setItem: (k, v) => saved.set(k, String(v)),
    removeItem: k => saved.delete(k),
  }
  const applyThemeVars = (theme, accent) => applied.push({ theme, accent })
  const stubs = {
    './apply': { applyThemeVars, currentTheme: () => ({ theme: 'mist', accent: '#0B8A54' }) },
    './palettes': { THEME_CATALOG: CATALOG },
    '../api': { ThemeApi: { saveAuto: () => Promise.resolve() } },
  }
  const code = ts.transpileModule(readFileSync(new URL('../src/theme/auto.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText
  const noop = () => {}
  const listeners = new Map()
  const window = {
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) },
    dispatchEvent: e => { for (const fn of listeners.get(e.type) || []) fn(e) },
  }
  const fire = (type, detail) => window.dispatchEvent({ type, detail })
  vm.runInNewContext(code, {
    module: { exports: exported },
    exports: exported,
    localStorage,
    window,
    document: { documentElement: { dataset: {}, style: { setProperty: noop } } },
    setInterval: () => 0,
    clearInterval: noop,
    CustomEvent: class {},
    require: name => stubs[name],
  })
  return { t: exported, saved, applied, fire }
}

const at = (h, m = 0) => new Date(2026, 10, 17, h, m, 0)

test('normalizeAuto 把垃圾配置收回默认值', () => {
  const { t } = load()
  assert.deepEqual({ ...t.normalizeAuto({ mode: 'nonsense', from: '25:99', to: 'ab' }) }, {
    mode: 'off', light: 'mist', dark: 'obsidian', from: '19:00', to: '07:00',
  })
})

test('inDarkWindow 处理跨午夜与 from===to', () => {
  const { t } = load()
  assert.equal(t.inDarkWindow(at(23), '19:00', '07:00'), true)
  assert.equal(t.inDarkWindow(at(6, 59), '19:00', '07:00'), true)
  assert.equal(t.inDarkWindow(at(7), '19:00', '07:00'), false)
  assert.equal(t.inDarkWindow(at(12), '19:00', '07:00'), false)
  assert.equal(t.inDarkWindow(at(9), '08:00', '18:00'), true)
  assert.equal(t.inDarkWindow(at(19), '08:00', '18:00'), false)
  assert.equal(t.inDarkWindow(at(23), '12:00', '12:00'), false)
})

test('off 模式不接管，也不碰任何主题变量', () => {
  const { t, applied } = load()
  assert.equal(t.evaluateAuto(at(23)), null)
  assert.equal(applied.length, 0)
})

test('time 模式：22:00 落到深色主题，12:00 落到浅色主题', () => {
  const { t, saved, applied } = load()
  t.updateAutoConfig({ mode: 'time', from: '19:00', to: '07:00' }, false)
  assert.deepEqual(JSON.parse(saved.get('pi_theme_auto')), {
    mode: 'time', light: 'mist', dark: 'obsidian', from: '19:00', to: '07:00',
  })
  const night = t.evaluateAuto(at(22))
  assert.equal(night.dir, 'dark')
  assert.equal(night.theme, 'obsidian')
  const noon = t.evaluateAuto(at(12))
  assert.equal(noon.dir, 'light')
  assert.equal(noon.theme, 'mist')
  // 自动接管只做运行时覆盖：不改用户手动选择
  assert.equal(saved.get('pi_theme'), undefined)
  assert.deepEqual(applied.slice(-2).map(a => a.theme), ['obsidian', 'mist'])
})

test('手动选的浅色在深色时段里被保留，时段一换自动重新接管', () => {
  const { t, saved, fire } = load()
  t.updateAutoConfig({ mode: 'time' }, false) // 默认 19:00-07:00
  t.setAutoClock(() => at(22)) // 钉住"现在 22 点"：手动选择走事件回调，拿不到调用方的时间
  t.startThemeAuto()
  fire('pi-theme-manual', { theme: 'shuimo' }) // 22 点档里手动选浅色
  const ov = JSON.parse(saved.get('pi_theme_auto_override'))
  assert.deepEqual(ov, { dir: 'light', natural: 'dark' })
  const state = t.evaluateAuto(at(22))
  assert.equal(state.theme, 'shuimo')
  assert.equal(state.overridden, true)
  // 手动选浅色会把浅色档位改成这套主题，白天自然方向就是它
  assert.equal(JSON.parse(saved.get('pi_theme_auto')).light, 'shuimo')
  // 走到白天，自然方向变成 light，覆盖作废
  const day = t.evaluateAuto(at(12))
  assert.equal(day.overridden, false)
  assert.equal(day.theme, 'shuimo')
  assert.equal(saved.get('pi_theme_auto_override'), undefined)
})

test('自动状态查询不产生副作用', () => {
  const { t, applied } = load()
  t.updateAutoConfig({ mode: 'time' }, false)
  applied.length = 0
  const s = t.autoState(at(23))
  assert.equal(s.theme, 'obsidian')
  assert.equal(s.mode, 'time')
  assert.equal(applied.length, 0)
})
