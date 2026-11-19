// AppearancePanel 渲染用例（2026-11-19）
// 目的：设置页那个「自动深色」开关不只是编译过——真渲染一次，确认
//   1) 默认关闭时开关 aria-checked=false、文案是「关闭中」；
//   2) 开成按时段后，22:00 显示「深色」、12:00 显示「浅色」，时段输入框带着 19:00/07:00。
// 做法：ts.transpileModule 把 .tsx 编成 CJS，用 vm 跑；react / react-dom/server 用真包，
//      lucide-react / toast / 主题目录用桩。只做 SSR 静态渲染，不跑 useEffect（那是浏览器的事）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const CATALOG = [
  { id: 'mist', name: '晨雾', light: true },
  { id: 'obsidian', name: '玄武' },
]

function transpile(rel, jsx) {
  return ts.transpileModule(readFileSync(new URL(rel, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
}

// 用给定 localStorage 起一套模块（每次调用都是干净的模块实例）
function boot(saved = {}) {
  const store = new Map(Object.entries(saved))
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }
  const auto = {} // auto.ts 的导出，填进下面 stub 表
  const stubs = {
    './apply': { applyThemeVars: () => {}, currentTheme: () => ({ theme: 'mist', accent: '#0B8A54' }) },
    './palettes': { THEME_CATALOG: CATALOG },
    '../api': { ThemeApi: { saveAuto: () => Promise.resolve() } },
    '../../theme/auto': auto,
    '../../theme/palettes': { THEME_CATALOG: CATALOG },
    '../shell/Toast': { toast: () => {} },
    'lucide-react': { Moon: () => null, Sun: () => null, Clock: () => null },
    react: require('react'),
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-dom/server': require('react-dom/server'),
  }
  // auto.ts 直接读全局 localStorage，vm 沙箱里必须挂上，两次加载共用同一个 context
  const ctx = vm.createContext({ console, setInterval, clearInterval, JSON, Object, localStorage, Date })
  const mod = (src) => {
    const m = { exports: {} }
    const fn = vm.runInContext(`(function(require,module,exports){${src}\n})`, ctx)
    fn((id) => {
      if (!(id in stubs)) throw new Error('未预期的导入: ' + id)
      return stubs[id]
    }, m, m.exports)
    return m.exports
  }
  Object.assign(auto, mod(transpile('../src/theme/auto.ts', ts.JsxEmit.None)))
  const Panel = mod(transpile('../src/components/panels/AppearancePanel.tsx', ts.JsxEmit.ReactJSX)).default
  const React = require('react')
  const renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup
  return { auto, render: () => renderToStaticMarkup(React.createElement(Panel)), store }
}

test('默认关闭：开关 aria-checked=false，文案说明只用主题画廊手选', () => {
  const { render } = boot()
  const html = render()
  assert.match(html, /role="switch"/)
  assert.match(html, /aria-checked="false"/)
  assert.match(html, /关闭中：只用你在主题画廊里手选的那套。/)
  assert.doesNotMatch(html, /aria-label="深色开始时间"/) // 关闭时不显示时段输入
})

test('按时段开启：22:00 显示深色玄武，12:00 显示浅色晨雾，时段回填 19:00/07:00', () => {
  const cfg = JSON.stringify({ mode: 'time', light: 'mist', dark: 'obsidian', from: '19:00', to: '07:00' })

  const night = boot({ pi_theme_auto: cfg })
  night.auto.setAutoClock(() => new Date(2026, 10, 19, 22, 0))
  const h1 = night.render()
  assert.match(h1, /aria-checked="true"/)
  assert.match(h1, /此刻应是深色「玄武」/)
  assert.match(h1, /19:00–07:00/)
  assert.match(h1, /value="19:00"/)

  const noon = boot({ pi_theme_auto: cfg })
  noon.auto.setAutoClock(() => new Date(2026, 10, 19, 12, 0))
  const h2 = noon.render()
  assert.match(h2, /aria-checked="true"/)
  assert.match(h2, /此刻应是浅色「晨雾」/)
  assert.match(h2, /value="07:00"/)
})

test('跟随系统模式：不显示时段输入，文案说「跟随系统」', () => {
  const { auto, render } = boot({ pi_theme_auto: JSON.stringify({ mode: 'system', light: 'mist', dark: 'obsidian' }) })
  auto.setAutoClock(() => new Date(2026, 10, 19, 22, 0))
  const html = render()
  assert.match(html, /aria-checked="true"/)
  assert.match(html, /跟随系统/)
  assert.doesNotMatch(html, /aria-label="深色开始时间"/)
})
