import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = join(ROOT, 'frontend', 'src')
const read = (...parts) => readFileSync(join(SRC, ...parts), 'utf8')

test('公共页标题允许省略说明，且不保留空段落', () => {
  const header = read('components', 'PageHeader.tsx')
  assert.ok(header.includes('description?: string'), '说明文字必须可省略')
  const descriptionLine = header.split('\n').find(line => line.includes('page-header__description'))
  assert.ok(descriptionLine?.includes('description &&'), '无说明时不得渲染空段落')
})

test('桌面导航把引擎作为一等工作入口，并显示文字标签', () => {
  const nav = read('nav.ts')
  const layout = read('AppLayout.tsx')
  const primary = nav.split('export const RAIL_PRIMARY = [')[1]?.split(']')[0] || ''
  assert.ok(primary.includes("'engine'"), '引擎必须进入桌面主导航')
  assert.ok(layout.includes('desktop-rail-item'), '桌面导航项必须使用可读的标签样式')
  assert.ok(layout.includes('<span className="desktop-rail-label">{n.label}</span>'), '桌面主导航必须显示文字标签')
})

test('主题同步在公共布局执行，不能依赖仅桌面挂载的主题按钮', () => {
  const layout = read('AppLayout.tsx')
  const switcher = read('components', 'shell', 'ThemeSwitcher.tsx')
  const apply = read('theme', 'apply.ts')
  assert.ok(layout.includes('useThemePreferences(authed)'), '两端必须共用登录后的主题同步')
  assert.ok(!switcher.includes('ThemeApi.get()'), '主题按钮不得另发一次同步请求')
  assert.ok(!switcher.includes('remoteReady'), '挂载或远程恢复主题不得自动回写服务端')
  assert.ok(apply.includes('restoreThemePreferences'), '远程偏好必须使用只恢复不回写的路径')
})

test('引擎总览只展示事实，并为每个来源显示独立的不可用状态', () => {
  const engine = read('pages', 'Engine.tsx')
  assert.ok(!engine.includes('是否值得信任'), '不能用营销问句代替运行事实')
  assert.ok(!engine.includes('已就绪'), '注册工具数不能冒充就绪状态')
  assert.ok(engine.includes('runUnavailable'), '运行摘要必须感知请求失败')
  assert.ok(engine.includes('toolsUnavailable'), '工具摘要必须感知请求失败')
  assert.ok(engine.includes('statusUnavailable'), '插件摘要不能忽略状态请求失败')
  assert.ok(engine.includes('当前模型选择'), '所选模型不能冒充实际执行模型')
})

test('欢迎工作区有明确身份与命令入口，不再用渐变场和说明文字占首屏', () => {
  const chat = read('components', 'chat', 'ChatArea.tsx')
  assert.ok(!chat.includes('<GradientField'), '工作入口不应加载装饰性 3D 渐变场')
  assert.ok(chat.includes('chat-workstart'), '欢迎页需要独立的工作入口布局')
  assert.ok(!chat.includes('快速进入，不用翻菜单'), '界面不应自述功能')
  assert.ok(!chat.includes('打开全局命令面板；'), '快捷键帮助不应占主内容')
})

test('引擎控制台首屏是摘要优先，详细诊断默认折叠', () => {
  const engine = read('pages', 'Engine.tsx')
  assert.ok(engine.includes('data-slot="engine-overview"'), '引擎页必须有首屏摘要区域')
  assert.ok(engine.includes('data-slot="engine-sections"'), '引擎页必须有详细区块容器')
  assert.match(engine, /<details[\s\S]*引擎配置/, '引擎配置必须进入可折叠详细区')
  assert.match(engine, /<details[\s\S]*工具目录/, '工具目录必须进入可折叠详细区')
  assert.match(engine, /<details[\s\S]*Gateway 与旁路/, 'Gateway 必须进入可折叠详细区')
  assert.doesNotMatch(engine, /<details[^>]*\sopen(?:=|\s|>)/, '详细区默认不得全部展开')
})

test('壁纸只做背景层，工作画布保持不透明可读', () => {
  const css = read('styles.css')
  assert.match(css, /body\.has-wallpaper \.col-canvas\s*\{[\s\S]*background:\s*var\(--pi-bg\)/, '壁纸模式的主画布必须保持实底')
  assert.match(css, /body\.has-wallpaper #pi-wallpaper\s*\{[\s\S]*opacity:\s*0\.22/, '壁纸必须退到低存在感')
  assert.match(css, /\.desktop-rail\s*\{[\s\S]*width:\s*132px/, '桌面主导航需要稳定宽度承载标签')
})
