import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = file => readFileSync(join(ROOT, 'frontend', 'src', file), 'utf8')

test('Markdown links expose copy and in-app browser actions', () => {
  const link = read('components/FileLink.tsx')
  const clipboard = read('lib/clipboard.ts')
  const markdown = read('components/Markdown.tsx')
  assert.ok(link.includes('复制链接'), '链接操作必须有复制链接入口')
  assert.ok(link.includes('pi-open-browser'), '链接必须能发出内置浏览器打开事件')
  assert.ok(link.includes('handleLinkClick'), '普通链接点击必须留在元枢内置浏览器')
  assert.ok(clipboard.includes('navigator.clipboard'), '复制优先使用 Clipboard API')
  assert.ok(clipboard.includes('execCommand'), '复制失败时必须有兼容回退')
  assert.ok(markdown.includes('<FileLink href={href}>'), 'Markdown 的真实 href 必须交给 FileLink')
})

test('内置浏览器面板提供地址栏、导航和移动端全屏容器', () => {
  const panel = read('components/BrowserPanel.tsx')
  const layout = read('AppLayout.tsx')
  const mobile = read('components/MobileMoreMenu.tsx')
  assert.ok(panel.includes('aria-label="浏览器地址"'), '浏览器必须有可访问地址栏')
  assert.ok(panel.includes('<iframe'), '浏览器必须有内嵌页面区域')
  assert.ok(panel.includes('sandbox="allow-forms allow-modals allow-popups allow-presentation allow-scripts"'), '内嵌页面必须隔离')
  assert.equal(panel.includes('window.history.back'), false, '面板后退不能改变主应用路由')
  assert.ok(panel.includes('在当前窗口打开'), '必须保留当前窗口外部打开入口')
  assert.ok(panel.includes('复制当前地址'), '地址栏必须可复制')
  assert.ok(panel.includes('回到元枢工作台'), '内置浏览器必须提供明确的返回工作台入口')
  assert.ok(panel.includes('__yuanshuBrowserPanel'), '系统返回键必须先关闭内置浏览器面板')
  assert.ok(panel.includes('window.location.assign(currentUrl)'), '外部页面应在当前窗口打开，保留浏览器后退返回工作台')
  assert.ok(panel.includes('在当前窗口打开'), '外部打开按钮必须明确提示当前窗口行为')
  assert.ok(layout.includes('<BrowserPanel'), '布局必须挂载浏览器面板')
  assert.ok(layout.includes('Globe2'), '桌面主导航必须提供浏览器入口')
  assert.ok(mobile.includes('onOpenBrowser'), '手机更多菜单必须提供浏览器入口')
})
