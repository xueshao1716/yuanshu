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

// 2026-11-16 页面块减字：区块说明默认收进「？」，点开才显示；页头说明只占一行
test('区块说明默认收起，用可访问的「？」按钮展开', () => {
  const section = read('components', 'SectionHeader.tsx')
  assert.match(section, /aria-expanded=\{open\}/, '说明按钮要报告展开状态')
  assert.match(section, /description && open &&/, '说明默认不渲染，展开后才出现')
  const css = read('styles.css')
  assert.match(css, /\.page-header__description\s*\{[^}]*-webkit-line-clamp:\s*1/s, '页头说明只占一行')
})

test('页面不再引用未定义的 --pi-panel（会退成白底，深色主题下字看不见）', () => {
  for (const file of [['pages', 'Gateway.tsx'], ['soul', 'ProactiveCard.tsx']]) {
    assert.doesNotMatch(read(...file), /var\(--pi-panel[,)]/, file.join('/'))
  }
})

test('工作台里的链接不带浏览器默认的下划线和链接色', () => {
  const css = read('components', 'board', 'board-home.css')
  assert.match(css, /\.board-shortcuts a[\s\S]{0,200}text-decoration:\s*none/, 'board 链接要重置')
})

test('事务台：区块走统一卡片与 SectionHeader，段尾解释收进「？」', () => {
  const gw = read('pages', 'Gateway.tsx')
  const css = read('styles.css')
  assert.ok(gw.includes('data-gw'), '事务台根节点要有 data-gw 钩子')
  assert.ok(/:root \[data-gw\] section\.panel/.test(css), '事务台区块要有可见卡片底')
  assert.ok(gw.includes('<PageHeader'), '页头用公共 PageHeader')
  assert.ok(!gw.includes('<h2 className'), '区块标题统一走 SectionHeader')
  for (const s of ['dispatch 会派给定时引擎', '验证=交付门严格度', '判定逻辑：改过的文件', '说清要什么能力，她去写']) {
    const idx = gw.indexOf(s)
    assert.ok(idx > 0, `保留说明：${s}`)
    assert.ok(gw.lastIndexOf('description=', idx) > gw.lastIndexOf('<p', idx), `${s} 应该进 description，不是常驻段落`)
  }
})

test('运行健康：面板脚注/图例收成数字与颜色，长解释只放 title', () => {
  const p = (n) => read('components', 'panels', n)
  const vit = p('HealthVitalityPanel.tsx'), deg = p('HealthDegradationPanel.tsx'), asm = p('HealthAssemblyPanel.tsx')
  const health = read('pages', 'Health.tsx')
  assert.ok(!vit.includes('{data.line &&'), '新鲜度：不再重复一行计数文字')
  assert.ok(!/<p[^>]*>\s*这套体检由后台/.test(vit), '新鲜度：落盘说明不作段落')
  assert.ok(!/<p[^>]*>\s*分类规则/.test(asm), '定时任务：分类规则不作段落')
  assert.ok(!/<p[^>]*>\s*自动边界/.test(deg), '退化：自动边界不作段落')
  assert.ok(!/<p[^>]*>\s*已评估/.test(deg), '退化：评估维度说明不作段落')
  assert.ok(!deg.includes('总分；'), '退化：阈值说明进 title')
  assert.ok(!health.includes('只读观测：本页没有任何开关'), '页头不再挂一行说明')
})

test('工作台最近会话：微信桥会话显示短名，不露原始 id', () => {
  const welcome = read('components', 'board', 'BoardWelcome.tsx')
  assert.ok(welcome.includes('displayName'), '复用侧栏的 displayName')
  assert.ok(!welcome.includes('<h3>{session.name'), '不能直接渲染原始会话名')
})

test('深色主题下 .panel 有可见卡片底（不再与页面同为 bg1）', () => {
  const css = read('styles.css')
  for (const t of ['obsidian']) {
    assert.ok(css.includes(`:root[data-theme="${t}"] .panel`), `${t} 主题要给 .panel 叠底`)
  }
})

test('事务台第一屏只留要拍板和每天看的，机制区收进「高级」', () => {
  const gw = read('pages', 'Gateway.tsx')
  const more = gw.indexOf('data-gw-more')
  assert.ok(more > 0, '要有高级折叠区')
  for (const t of ['待你处理', '只读模式', '外面进来的事', '走过的弯路']) assert.ok(gw.indexOf(`title="${t}"`) < more, `${t} 在第一屏`)
  for (const t of ['脑区', '动作策略', '造技能', '路由判断']) assert.ok(gw.indexOf(`title="${t}"`) > more, `${t} 收进高级`)
  assert.ok(gw.indexOf('title="待你处理"') < gw.indexOf('title="只读模式"'), '待你处理放最前')
})

// 2026-11-16 外网新电脑黑屏：旧浏览器解析不了主包时，页面要给出原因而不是一片空
test('启动失败有兜底提示，构建目标覆盖较旧浏览器', () => {
  const html = readFileSync(join(ROOT, 'frontend', 'index.html'), 'utf8')
  assert.ok(html.indexOf('/boot-check.js') > 0 && html.indexOf('/boot-check.js') < html.indexOf('type="module"'), '兜底脚本要排在主包前面')
  const boot = readFileSync(join(ROOT, 'frontend', 'public', 'boot-check.js'), 'utf8')
  assert.doesNotMatch(boot, /=>|\blet\b|\bconst\b|`|\?\./, '兜底脚本只能用 ES5，老浏览器也要能跑')
  assert.ok(boot.includes('root'), '要检查 #root 是否渲染')
  const vite = readFileSync(join(ROOT, 'frontend', 'vite.config.ts'), 'utf8')
  assert.match(vite, /target:\s*\[[^\]]*chrome8\d/, '显式构建目标，覆盖 Chrome 8x 一代')
})

test('启动兜底脚本免 token 可取（新电脑还没登录）', () => {
  const server = readFileSync(join(ROOT, 'server.mjs'), 'utf8')
  const hits = server.split('\n').filter(l => l.includes('url.pathname === "/manifest.webmanifest"'))
  assert.ok(hits.length >= 2 && hits.every(l => l.includes('"/boot-check.js"')), '鉴权白名单与静态分发都要放行 /boot-check.js')
})
