// Tauri Android 键盘避让契约测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

 test('Tauri MainActivity 必须把真实 IME inset 注入当前 WebView', () => {
  const src = read('app', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java', 'com', 'yuanshu', 'app', 'MainActivity.kt')
  assert.match(src, /WindowInsetsCompat\.Type\.ime\(\)/, '必须读取 Android IME WindowInsets')
  assert.match(src, /ViewCompat\.setOnApplyWindowInsetsListener/, '必须监听 WebView 的 WindowInsets')
  assert.match(src, /evaluateJavascript/, '必须把 IME 状态通知给 WebView')
  assert.match(src, /yuanshu-ime/, '必须发送稳定的原生键盘事件名')
})

test('Tauri Manifest 必须保留 adjustResize', () => {
  const manifest = read('app', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/)
})

test('Capacitor 手机壳（实际交付的 APK）必须有同一套 IME 契约——不能只管 Tauri', () => {
  // 2026-10-12 回归：IME 修复只落在 Tauri 包，Capacitor 包没有；状态栏修复关闭 insetsHandling 后键盘直接盖输入框
  const java = read('android', 'app', 'src', 'main', 'java', 'com', 'pixinyu', 'app', 'MainActivity.java')
  assert.match(java, /WindowInsetsCompat\.Type\.ime\(\)/, '必须读取 Android IME WindowInsets')
  assert.match(java, /ViewCompat\.setOnApplyWindowInsetsListener/, '必须监听 WebView 的 WindowInsets')
  assert.match(java, /evaluateJavascript/, '必须把 IME 状态通知给 WebView')
  assert.match(java, /yuanshu-ime/, '必须发送稳定的原生键盘事件名')
  assert.match(java, /\/\s*safeDensity|density/, '物理像素必须换 CSS 像素')
  const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml')
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/, 'Capacitor manifest 必须保留 adjustResize')
})

test('前端必须消费原生 IME 高度且不与 visualViewport 双重缩短', () => {
  const viewport = read('frontend', 'src', 'lib', 'viewport.ts')
  const css = read('frontend', 'src', 'styles.css')
  assert.match(viewport, /yuanshu-ime/, '前端必须监听 Tauri 原生 IME 事件')
  assert.match(viewport, /pi-native-keyboard-inset/, '前端必须保存原生键盘高度')
  assert.match(viewport, /visualInset|visualViewport/, '必须保留浏览器 visualViewport 兼容路径')
  assert.match(css, /pi-native-keyboard-inset/, '移动根布局必须使用原生键盘高度兜底')
})

test('原生 IME 高度必须换成 CSS 像素，避免荣耀矮屏把输入框顶到最上', () => {
  const src = read('app', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java', 'com', 'yuanshu', 'app', 'MainActivity.kt')
  assert.match(src, /displayMetrics\.density/, 'WindowInsets 是物理像素，注入 WebView 前必须除以 density')
  assert.match(src, /imeBottom\s*\/\s*density/, '注入的 height 必须是 CSS 像素')
})

test('键盘打开时收起底栏，输入框只贴键盘上沿而不是再叠一层 TabBar', () => {
  const css = read('frontend', 'src', 'styles.css')
  assert.match(css, /html\.keyboard-open\s+\.mobile-tab-bar/, '键盘打开必须收起移动底栏')
  assert.match(css, /safe-area-inset-left/, '横屏刘海左右安全区必须吃进移动根布局')
})
