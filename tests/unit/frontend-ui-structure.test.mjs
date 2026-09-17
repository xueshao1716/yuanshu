import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = join(ROOT, 'frontend', 'src')
const read = (...parts) => readFileSync(join(SRC, ...parts), 'utf8')

test('聊天与首页数据层只在恢复时增量同步，避免整页重载', () => {
  const store = read('store.tsx')
  const chat = read('components', 'ChatArea.tsx')

  assert.match(store, /const \{ data: modelsData \} = useSWR[\s\S]*?revalidateOnFocus:\s*false/, '模型配置不因焦点切换整页重拉')
  assert.match(store, /const \{ data: sessionsData \} = useSWR[\s\S]*?revalidateOnFocus:\s*true/, '会话目录恢复焦点时应增量重验')
  assert.match(chat, /revalidateOnFocus:\s*true/, '当前会话恢复焦点时应增量重验')
  assert.ok(chat.includes('let primed = false') || chat.includes('primed = false'), '打开会话必须等 subscribed 再同步，避免重放 session_updated 触发第二次整段 /messages')
  assert.ok(chat.includes("event?.type === 'message' || event?.type === 'turn_end' || event?.type === 'session_updated'"), '会话同步只应在新消息或轮次结束边界触发')
  assert.ok(chat.includes('if (!primed) return') || chat.includes('if (!primed)'), '重放阶段不得 mutateMsgs')
  assert.ok(chat.includes('SessionsApi.messages(sid, { tail:') || chat.includes('SessionsApi.messages(sid,{ tail:'), '打开会话只拉尾部窗口')
  assert.doesNotMatch(chat, /setTimeout\(\(\) => \{ if \(alive && !streamRef\.current\) mutateMsgs\(\) \}, 6000\)/, '连接短暂出错不得用延迟整段重载制造闪屏')
})

test('会话 SSE 解析命名 session_updated 事件，确保跨端记录及时同步', () => {
  const api = read('api.ts')
  assert.match(api, /eventType = 'message'/, 'streamSession 必须解析 SSE 默认事件类型')
  assert.match(api, /\['message', 'subscribed', 'session_updated'\]/, 'streamSession 必须识别后端命名的 session_updated 事件')
  assert.match(api, /Authorization:\s*`Bearer \$\{_token\}`/, 'streamSession 必须发送 Authorization')
  assert.ok(api.includes('/messages') && api.includes('tail'), 'messages API 必须能带 tail 尾窗')
  assert.ok(api.includes('leafId'), 'messages API 必须能带当前枝 leafId')
})
test('对话欢迎页提供高频工作入口，长会话阅读区有稳定的阅读列', () => {
  const chat = read('components', 'ChatArea.tsx')
  const turns = read('components', 'TurnList.tsx')
  for (const label of ['新建对话', 'AI 绘画', '生成 PPT', '定时任务', '会话管理']) {
    assert.ok(chat.includes(`label: '${label}'`), `欢迎页缺少高频入口：${label}`)
  }
  assert.ok(chat.includes('chat-reading-column'), '长会话消息区必须有语义阅读列')
  assert.ok(turns.includes('chat-history-head'), '长会话折叠历史必须有明确阅读分隔')
})

test('壁纸模式下主画布与新建对话首页保持透明', () => {
  const chat = read('components', 'ChatArea.tsx')
  const layout = read('AppLayout.tsx')
  const styles = read('styles.css')
  assert.ok(chat.includes('className="chat-welcome chat-workstart"'), '欢迎页必须使用工作入口布局')
  assert.match(layout, /route === 'chat' \? 'mobile-chat-root' : ''/, '移动端仅聊天壳需要透出壁纸')
  assert.match(layout, /route === 'chat' \? 'chat-canvas' : ''/, '桌面端仅聊天画布需要透出壁纸')
  assert.match(styles, /body\.has-wallpaper \.chat-canvas,\s*body\.has-wallpaper \.mobile-chat-root\s*\{\s*background:\s*transparent;/s, '壁纸开启时聊天画布与移动聊天壳必须透明')
  assert.match(styles, /body\.has-wallpaper \.chat-welcome\s*\{\s*background:\s*transparent;/s, '壁纸开启时新建对话欢迎页必须透明')
})

test('侧栏三个主分组：工作会话、小语真测、小语终端，工作会话在前', () => {
  const sidebar = read('components', 'Sidebar.tsx')
  assert.ok(sidebar.includes("workspace: '工作会话'"), '工作分组文案必须是工作会话')
  assert.ok(sidebar.includes("test: '小语真测'"), '真测分组文案必须是小语真测')
  assert.ok(sidebar.includes("terminal: '小语终端'"), '终端分组文案必须是小语终端')
  assert.ok(sidebar.includes("const GROUP_ORDER = ['workspace', 'test', 'terminal']"), '分组顺序必须是工作会话 → 小语真测 → 小语终端')
  assert.ok(!sidebar.includes('工作空间会话'), '不得继续使用工作空间会话旧文案')
  assert.ok(!sidebar.includes('小语会话（终端）'), '不得继续使用小语会话（终端）旧文案')
})

test('侧栏品牌头使用与安装包一致的元枢 App 图标，并只保留小语身份名', () => {
  const sidebar = read('components', 'Sidebar.tsx')
  const brand = join(ROOT, 'frontend', 'public', 'branding', 'yuanshu-app-icon.png')
  const desktop = join(ROOT, 'app', 'src-tauri', 'icons', '128x128.png')
  assert.ok(existsSync(brand), '前端静态目录必须提供元枢 App 图标')
  assert.ok(existsSync(desktop), '桌面安装包图标必须存在')
  assert.deepEqual(readFileSync(brand), readFileSync(desktop), '网页顶栏图标必须与桌面 128 图标同一份，不能再用「元」字渐变图')
  assert.match(sidebar, /src="\/static\/branding\/yuanshu-app-icon\.png/, '侧栏品牌头必须引用元枢 App 图标的服务端静态路径')
  assert.match(sidebar, /alt="元枢"/, '品牌图标必须提供元枢替代文本')
  assert.ok(sidebar.includes('>小语</div>'), '侧栏必须保留小语作为伙伴身份名')
  assert.doesNotMatch(sidebar, />元枢工作台</, '侧栏不得继续展示与元枢图标重复的文字副标题')
  assert.doesNotMatch(sidebar, /from-pi-accent to-pi-accent2/, '品牌头不得继续使用旧的渐变“语”字标')
})

test('移动底栏固定为对话、会话、资产、任务、更多，且删除可拖动 MobileFab', () => {
  const layout = read('AppLayout.tsx')
  const labels = [...layout.matchAll(/label: '([^']+)'/g)].map(match => match[1])
  const mobileTabs = labels.slice(-5)
  assert.deepEqual(mobileTabs, ['对话', '会话', '资产', '任务', '更多'])
  assert.ok(layout.includes('onLogout={logout}'), '移动壳必须把 logout 交给更多菜单')
  assert.ok(!layout.includes('MobileFab'), 'AppLayout 不得继续引用 MobileFab')
  assert.equal(existsSync(join(SRC, 'components', 'MobileFab.tsx')), false, '可拖动 FAB 文件必须删除')
})

test('更多菜单承载设置路由和辅助面板，并提供可访问状态', () => {
  const menu = read('components', 'MobileMoreMenu.tsx')
  for (const route of ['board', 'lingxi', 'workshop', 'models', 'apps', 'engine', 'themes', 'sessiondb', 'system']) {
    assert.ok(menu.includes(`route: '${route}'`), `更多菜单缺少 ${route} 路由`)
  }
  for (const panel of ['workspace', 'deliveries', 'terminal', 'activity', 'tui']) {
    assert.ok(menu.includes(`panel: '${panel}'`), `更多菜单缺少 ${panel} 面板入口`)
  }
  assert.ok(menu.includes("e.key === 'Escape'"), '更多菜单必须支持 Esc 关闭')
  assert.ok(menu.includes('aria-current'), '更多菜单当前路由必须暴露 aria-current')
  assert.ok(menu.includes('退出登录'), '手机更多菜单必须提供退出登录')
  assert.ok(menu.includes('onLogout'), '退出必须走壳层 logout，不能只跳路由')
})

test('更多菜单打开时底栏只能有更多一个 aria-current', () => {
  const layout = read('AppLayout.tsx')
  for (const activeContract of [
    "active: !mobileMoreOpen && route === 'chat' && mobileDrawer === 'none'",
    "active: !mobileMoreOpen && mobileDrawer === 'sessions'",
    "active: !mobileMoreOpen && route === 'assets' && mobileDrawer === 'none'",
    "active: !mobileMoreOpen && route === 'tasks' && mobileDrawer === 'none'",
  ]) {
    assert.ok(layout.includes(activeContract), `底栏活跃态缺少互斥契约：${activeContract}`)
  }
  assert.ok(layout.includes("active: mobileMoreOpen || (mobileDrawer === 'none'"), '更多打开时必须保持更多活跃')
  assert.equal((layout.match(/aria-current=\{item\.active \? 'page' : undefined\}/g) || []).length, 1, '移动底栏 aria-current 必须只由互斥 item.active 单点控制')
})

test('更多菜单打开后圈定焦点，关闭后把焦点还给更多触发按钮', () => {
  const layout = read('AppLayout.tsx')
  const menu = read('components', 'MobileMoreMenu.tsx')
  assert.ok(layout.includes('const mobileMoreTriggerRef = useRef<HTMLButtonElement>(null)'), 'AppLayout 必须持有更多触发按钮 ref')
  assert.ok(layout.includes("ref={item.key === 'more' ? mobileMoreTriggerRef : undefined}"), '更多按钮必须绑定恢复焦点 ref')
  assert.ok(layout.includes('mobileMoreTriggerRef.current?.focus()'), '关闭菜单后必须由 AppLayout 恢复触发按钮焦点')
  assert.ok(menu.includes('const sheetRef = useRef<HTMLElement>(null)'), '更多 sheet 必须持有焦点边界 ref')
  assert.ok(menu.includes('const closeButtonRef = useRef<HTMLButtonElement>(null)'), '更多菜单必须持有初始焦点 ref')
  assert.ok(menu.includes('closeButtonRef.current?.focus()'), '菜单打开后必须主动聚焦关闭按钮')
  assert.ok(menu.includes("e.key !== 'Tab'"), '更多菜单必须处理 Tab 焦点循环')
  assert.ok(menu.includes('e.shiftKey'), '更多菜单必须处理 Shift+Tab 反向循环')
  assert.ok(menu.includes("sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)"), '焦点候选必须限定在 sheet 内')
  assert.ok(menu.includes('focusable[0]?.focus()'), '末项 Tab 必须回到首项')
  assert.ok(menu.includes('focusable[focusable.length - 1]?.focus()'), '首项 Shift+Tab 必须回到末项')
})

test('桌面工具区默认是真右栏，终端与 TUI 才可显式展开', () => {
  const layout = read('AppLayout.tsx')
  const panel = read('components', 'UtilityPanel.tsx')
  const css = read('styles.css')
  assert.ok(layout.includes('<UtilityPanel'), '桌面工具区必须通过 UtilityPanel 渲染')
  assert.ok(!/fixed inset-x-0 bottom-0[^\n]*col-right/.test(layout), '桌面工具区不得默认全屏覆盖')
  assert.match(css, /\.utility-panel\s*\{[\s\S]*?width:\s*clamp\(348px,[^;]+448px\)/, '桌面右栏应保留 348–448px，不挤压主阅读区')
  assert.ok(layout.includes('!sidebarAutoHidden && <Sidebar'), '自动收起与恢复入口必须使用相同条件')
  assert.ok(layout.includes('(sidebarCollapsed || sidebarAutoHidden)'), '自动隐藏后仍可找回会话列表')
  assert.ok(panel.includes("active === 'terminal' || active === 'tui'"), '仅终端/TUI 提供显式展开')
  assert.ok(panel.includes("e.key === 'Escape'"), '工具面板必须支持 Esc 关闭')
  assert.ok(panel.includes('aria-expanded={expanded}'), '展开按钮必须暴露 aria-expanded')
})

test('移动导航与面板交互目标至少 44px，并尊重底部安全区', () => {
  const css = read('styles.css')
  assert.match(css, /\.mobile-tab-button\s*\{[\s\S]*?min-height:\s*44px/, '移动 Tab 触控高度不得小于 44px')
  assert.match(css, /\.mobile-more-action\s*\{[\s\S]*?min-height:\s*44px/, '更多菜单操作触控高度不得小于 44px')
  assert.ok(css.includes('env(safe-area-inset-bottom'), '固定移动导航必须尊重底部安全区')
})

test('模型中心拆分为窄职责组件，第一屏按当前模型、筛选、结果网格排列', () => {
  const hub = read('pages', 'ModelHub.tsx')
  for (const component of ['ActiveModelHero', 'ModelFilterBar', 'ModelCard']) {
    const file = join(SRC, 'components', 'models', `${component}.tsx`)
    assert.ok(existsSync(file), `模型中心缺少 ${component} 组件`)
    assert.ok(hub.includes(`<${component}`), `ModelHub 必须使用 ${component}`)
  }
  const order = [
    hub.indexOf('<PageHeader'),
    hub.indexOf('<ActiveModelHero'),
    hub.indexOf('<ModelFilterBar'),
    hub.indexOf('data-slot="model-results"'),
  ]
  assert.ok(order.every(index => index >= 0), 'ModelHub 缺少 PageHeader → hero → 筛选 → 结果网格结构标记')
  assert.deepEqual([...order].sort((a, b) => a - b), order, '模型中心第一屏顺序必须为 PageHeader → 当前模型 → 筛选 → 结果网格')
})

test('模型通道、累计用量和 Provider 明细统一位于默认折叠的通道与用量区', () => {
  const hub = read('pages', 'ModelHub.tsx')
  const detailsStart = hub.indexOf('<details')
  const detailsEnd = hub.indexOf('</details>', detailsStart)
  assert.ok(detailsStart >= 0 && detailsEnd > detailsStart, '模型中心必须提供 details 折叠区')
  const details = hub.slice(detailsStart, detailsEnd)
  assert.ok(!/<details[^>]*\sopen(?:=|\s|>)/.test(details), '通道与用量必须默认折叠')
  for (const content of ['通道与用量', '累计成本', '累计消息', '<ModelChannels', 'Provider 用量']) {
    assert.ok(details.includes(content), `通道与用量折叠区缺少：${content}`)
  }
})

test('模型中心业务组件只使用语义状态色，不含固定 emerald、purple、sky 色类', () => {
  const files = [
    ['pages', 'ModelHub.tsx'],
    ['components', 'ModelChannels.tsx'],
    ['components', 'models', 'ActiveModelHero.tsx'],
    ['components', 'models', 'ModelFilterBar.tsx'],
    ['components', 'models', 'ModelCard.tsx'],
  ]
  const offenders = []
  for (const parts of files) {
    const file = join(SRC, ...parts)
    if (!existsSync(file)) continue
    const source = read(...parts)
    if (/(?:emerald|purple|sky)-/.test(source)) offenders.push(parts.join('/'))
  }
  assert.deepEqual(offenders, [], `固定状态色应改用 pi-success/pi-info/pi-accent：${offenders.join(', ')}`)
})

test('模型中心保留 store、统计刷新、模型切换和通道增删契约，排序不突变 models', () => {
  const hub = read('pages', 'ModelHub.tsx')
  const channels = read('components', 'ModelChannels.tsx')
  for (const storeValue of ['models', 'currentModel', 'cwd']) {
    assert.match(hub, new RegExp(`\\b${storeValue}\\b`), `ModelHub 必须保留 ${storeValue}`)
  }
  assert.ok(hub.includes("useSWR('provider-stats', () => StatsApi.providers(), { refreshInterval: 60000 })"), 'Provider 统计必须继续每 60 秒刷新')
  assert.ok(hub.includes('await KeysApi.switchModel({ provider: model.provider, modelId: model.id })'), '模型切换必须继续调用 KeysApi.switchModel')
  assert.doesNotMatch(hub, /\bmodels\.sort\(/, '不得直接 sort store 的 models 数组')
  assert.match(hub, /\[\.\.\.filteredModels\]\.sort\(/, '免费优先排序必须基于筛选结果的新数组')
  for (const api of ['KeysApi.manage()', 'KeysApi.add(', 'KeysApi.remove(']) {
    assert.ok(channels.includes(api), `ModelChannels 必须保留 ${api}`)
  }
})

test('主题页使用公共页头，并按画廊、实时预览与精调、开发者选项组织', () => {
  const themes = read('pages', 'Themes.tsx')
  assert.ok(themes.includes('<PageHeader'), '主题页必须使用 PageHeader')
  assert.doesNotMatch(themes, /<h1\b/, '主题页不得手写 h1 页面头')
  const order = [
    themes.indexOf('<PageHeader'),
    themes.indexOf('data-slot="theme-gallery"'),
    themes.indexOf('data-slot="theme-workbench"'),
    themes.indexOf('<details'),
  ]
  assert.ok(order.every(index => index >= 0), '主题页缺少 PageHeader → 画廊 → 实时预览/精调 → 开发者选项结构')
  assert.deepEqual([...order].sort((a, b) => a - b), order, '主题页层级顺序不正确')
  assert.match(themes, /data-slot="theme-workbench"[^>]*className="[^"]*lg:grid-cols-/, '桌面端实时预览与精调必须形成主辅布局')
})

test('主题 Token 与 CSS 导出只位于默认关闭的开发者选项', () => {
  const themes = read('pages', 'Themes.tsx')
  const detailsStart = themes.indexOf('<details')
  const detailsEnd = themes.indexOf('</details>', detailsStart)
  assert.ok(detailsStart >= 0 && detailsEnd > detailsStart, '主题页必须提供开发者 details')
  const details = themes.slice(detailsStart, detailsEnd)
  assert.ok(!/<details[^>]*\sopen(?:=|\s|>)/.test(details), '开发者选项必须默认关闭')
  for (const content of ['开发者选项', 'Token 速览', 'onClick={exportCss}', '导出 CSS']) {
    assert.ok(details.includes(content), `开发者选项缺少：${content}`)
  }
  const ordinaryUi = themes.slice(themes.indexOf('return ('), detailsStart)
  assert.ok(!ordinaryUi.includes('onClick={exportCss}'), '普通用户主界面不得出现 CSS 导出工具')
})

test('主题页保留即时应用、精调、壁纸、保存与重置行为，且非 badge 不使用 10px', () => {
  const themes = read('pages', 'Themes.tsx')
  for (const behavior of [
    'const selectTheme =',
    'seedVars(theme, accent, density)',
    'setWallpaper(reader.result as string)',
    "setWallpaper('')",
    'await ThemeApi.save(theme, accent, wallpaper)',
    'onClick={handleReset}',
  ]) {
    assert.ok(themes.includes(behavior), `主题页必须保留行为：${behavior}`)
  }
  assert.doesNotMatch(themes, /text-\[10px\]/, '主题页不得把 10px 用于非 badge 文本或 WALL_PRESETS 按钮')
})

test('系统页以公共页头和四项真实状态摘要开场，主任务位于能力清单之前', () => {
  const system = read('pages', 'System.tsx')
  assert.ok(system.includes('<PageHeader'), '系统页必须使用 PageHeader')
  assert.doesNotMatch(system, /<h1\b/, '系统页不得手写 h1 页面头')
  const order = [
    system.indexOf('<PageHeader'),
    system.indexOf('data-slot="system-status"'),
    system.indexOf('data-slot="system-primary"'),
    system.indexOf('<details'),
  ]
  assert.ok(order.every(index => index >= 0), '系统页缺少 PageHeader → 状态摘要 → 主任务 → 能力折叠结构')
  assert.deepEqual([...order].sort((a, b) => a - b), order, '系统页必须先显示真实状态和主任务，能力清单置底')
  assert.equal((system.match(/<StatusTile\b/g) || []).length, 4, '系统顶部必须显示服务、版本、运行时长、网络四项摘要')
  for (const label of ['服务状态', '版本', '运行时长', '网络状态']) {
    assert.ok(system.includes(`label="${label}"`), `系统状态摘要缺少：${label}`)
  }
})

test('系统网络摘要只陈述已发现入口，不把配置数据解释为网络可达性', () => {
  const system = read('pages', 'System.tsx')
  const networkTileStart = system.indexOf('label="网络状态"')
  const networkTileEnd = system.indexOf('/>', networkTileStart)
  assert.ok(networkTileStart >= 0 && networkTileEnd > networkTileStart, '系统页必须提供网络状态摘要')
  const networkTile = system.slice(networkTileStart, networkTileEnd)
  assert.ok(system.includes('const networkEntryCount ='), '网络摘要必须基于入口计数描述已知事实')
  assert.match(networkTile, /已发现入口/, '存在 lanIPs 或 domains 时只能表述为已发现入口')
  assert.match(networkTile, /未发现入口/, '系统信息已返回但入口为空时只能表述为未发现入口')
  assert.match(networkTile, /等待系统信息/, '系统信息未返回时必须明确等待系统信息')
  assert.doesNotMatch(networkTile, /可用|未配置|待配置|在线|离线/, '网络摘要不得把入口配置解释为网络可达性')
})

test('功能一览默认折叠，保留更新、网络编辑保存与实际端口 LAN 复制行为', () => {
  const system = read('pages', 'System.tsx')
  const detailsStart = system.indexOf('<details')
  const detailsEnd = system.indexOf('</details>', detailsStart)
  assert.ok(detailsStart >= 0 && detailsEnd > detailsStart, '功能一览必须位于 details')
  const details = system.slice(detailsStart, detailsEnd)
  assert.ok(!/<details[^>]*\sopen(?:=|\s|>)/.test(details), '功能一览必须默认折叠')
  // 不能叫「系统能力」：主栏的「能力」是引擎运行时页，同名会让人以为两页重复
  assert.ok(details.includes('功能一览'), '折叠区必须包含功能清单')
  assert.ok(!details.includes('系统能力'), '折叠区不得再叫「系统能力」，与主栏「能力」页撞名')
  for (const behavior of [
    "useSWR('system-info', () => SystemApi.info(), { dedupingInterval: 30000 })",
    'SystemApi.checkUpdate()',
    'setRows([...domains',
    'setRows(domains.filter',
    'SystemApi.saveNetwork({ domains })',
    'copyText(lanUrl)',
    'copiedIp === lanUrl',
  ]) {
    assert.ok(system.includes(behavior), `系统页必须保留行为：${behavior}`)
  }
  assert.doesNotMatch(system, /copiedIp === `http:\/\/\$\{ip\}:8787`/, '复制状态不得硬编码 8787')
})

test('主题与系统页清除固定 emerald、非 badge 10px 与 emoji 式勾号，ModelChannels 删除未使用 X import', () => {
  const targets = [read('pages', 'Themes.tsx'), read('pages', 'System.tsx')]
  for (const source of targets) {
    assert.doesNotMatch(source, /emerald-/, '主题/系统页不得使用固定 emerald 色')
    assert.doesNotMatch(source, /text-\[10px\]/, '主题/系统页不得使用非 badge 10px')
    assert.doesNotMatch(source, /✓/, '主题/系统页不得使用 emoji 式勾号')
  }
  const channels = read('components', 'ModelChannels.tsx')
  assert.doesNotMatch(channels, /\bX\b/, 'ModelChannels 不得保留未使用 X import')
})

test('应用中心使用公共页头、桌面分组侧栏与移动单一选择器', () => {
  const apps = read('pages', 'Apps.tsx')
  assert.ok(apps.includes('<PageHeader'), '应用中心必须使用 PageHeader')
  assert.doesNotMatch(apps, /<h1\b/, '应用中心不得手写 h1 页面头')
  assert.ok(apps.includes('aria-label="应用工具导航"'), '桌面工具导航必须有可访问名称')
  assert.ok(apps.includes('aria-current={tab === tool.key ? \'page\' : undefined}'), '桌面工具导航必须暴露当前工具')
  assert.match(apps, /<aside[^>]*className="[^"]*hidden md:block/, '桌面端必须显示左侧工具导航')
  assert.match(apps, /<select[^>]*aria-label="选择应用工具"[^>]*className="[^"]*md:hidden/, '移动端必须使用单一紧凑工具选择器')
  assert.match(apps, /<select[^>]*aria-label="选择应用工具"[^>]*className="[^"]*min-h-11/, '移动端工具选择器触控高度不得小于 44px')
  for (const group of ['知识资产', '系统改进']) assert.ok(apps.includes(group), `应用导航缺少分组：${group}`)
  for (const view of ['<RefineView', '<SkillsView', '<PromptsView', '<ImproveView', '<EvolutionView', '<GardenerView']) {
    assert.ok(apps.includes(view), `应用中心必须保留内部 View：${view}`)
  }
  assert.ok(apps.includes('进化引擎'), '应用中心必须提供进化引擎入口')
  assert.ok(apps.includes('<SectionHeader'), '当前工具必须显示自己的标题与说明')
})

test('任务运行历史展示全文，不得截成 200 字或单行裁切', () => {
  const tasks = read('pages', 'Tasks.tsx')
  assert.doesNotMatch(tasks, /h\.result\.slice\(0,\s*200\)/, '运行结果不得再 slice 到 200 字')
  assert.doesNotMatch(tasks, /truncate mt-0\.5 max-h-20 overflow-hidden/, '运行结果不得用单行截断加固定高度裁切')
  assert.ok(tasks.includes('{h.result}'), '运行结果必须渲染完整字段')
  assert.ok(tasks.includes('whitespace-pre-wrap'), '运行结果必须可换行看全文')
})

test('任务中心统一页头、区块头、Lucide 空状态与创建首个任务动作', () => {
  const tasks = read('pages', 'Tasks.tsx')
  assert.ok(tasks.includes('<PageHeader'), '任务中心必须使用 PageHeader')
  assert.ok((tasks.match(/<SectionHeader/g) || []).length >= 2, '任务列表和新建表单必须使用 SectionHeader')
  assert.ok(tasks.includes('<EmptyState'), '任务空结果必须使用 EmptyState')
  assert.ok(tasks.includes('icon={CalendarClock}'), '任务空状态必须使用 Lucide 图标')
  assert.ok(tasks.includes("action={{ label: '创建第一个任务', onClick: focusCreateForm }}"), '空状态必须引导到现有创建表单')
  assert.ok(tasks.includes('formRef.current?.scrollIntoView'), '创建首个任务动作必须滚动到现有表单')
  assert.ok(tasks.includes('formPromptRef.current?.focus'), '创建首个任务动作必须聚焦现有指令输入')
  assert.doesNotMatch(tasks, /(?:emerald|amber)-/, '任务状态、历史和 hover 色必须使用语义 token')
  assert.doesNotMatch(tasks, /[⏰⚠]/, '任务中心不得使用结构 emoji')
  assert.doesNotMatch(tasks, />\s*\+ 创建\s*</, '创建按钮不得使用文本加号作为结构图标')
})

test('会话库使用公共页头，并为桌面表格和移动卡片提供等价信息', () => {
  const sessionDb = read('pages', 'SessionDb.tsx')
  assert.ok(sessionDb.includes('<PageHeader'), '会话库必须使用 PageHeader')
  assert.match(sessionDb, /data-slot="session-db-table"[^>]*className="[^"]*hidden md:block/, '桌面表格必须在 md 以下隐藏')
  assert.match(sessionDb, /data-slot="session-db-cards"[^>]*className="[^"]*md:hidden/, '移动卡片必须在 md 及以上隐藏')
  for (const marker of ['选择会话', '编号', '健康', '大小', '消息', '更新', '取消置顶', '置顶']) {
    assert.ok(sessionDb.includes(marker), `移动卡片缺少字段或动作：${marker}`)
  }
  assert.ok(sessionDb.includes('<EmptyState'), '空搜索结果必须使用 EmptyState')
  assert.ok(sessionDb.includes('data-slot="recall-panel"'), '会话库必须提供跨会话回忆面板')
  assert.match(sessionDb, /className="[^"]*min-h-11 min-w-11[^"]*" aria-label={`选择会话/, '移动选择按钮触控目标不得小于 44px')
  assert.match(sessionDb, /className={`[^`]*min-h-11 min-w-11[^`]*`}[^>]*aria-label={`\$\{r\.pinned/, '移动置顶按钮触控目标不得小于 44px')
  assert.doesNotMatch(sessionDb, /(?:emerald|amber|red)-/, '会话健康与置顶必须使用语义 token')
  assert.doesNotMatch(sessionDb, /📌/, '置顶不得使用 emoji')
})

test('会话库客户端排序以更新时间为主，编号只做最终稳定兜底', () => {
  const sessionDb = read('pages', 'SessionDb.tsx')
  assert.match(sessionDb, /updatedAt/, '会话库行数据必须保留更新时间')
  assert.ok(sessionDb.includes('function rowTime') && sessionDb.includes('.sort((a, b) =>'), '会话库必须按更新时间排序')
  assert.doesNotMatch(sessionDb, /\.sort\(\(a, b\) => \(b\.pinned \? 1 : 0\) - \(a\.pinned \? 1 : 0\) \|\| \(b\.seq/, '会话库不得再按编号主导排序')
})

test('工作台看板挂在桌面导航，并读现有 API 做一屏总览', () => {
  const layout = read('AppLayout.tsx')
  const routes = read('hooks', 'useHashRoute.tsx')
  const board = read('pages', 'Board.tsx')
  const menu = read('components', 'MobileMoreMenu.tsx')
  assert.ok(routes.includes("'board'"), 'hash 路由必须包含 board')
  assert.ok(layout.includes("route: 'board'"), '桌面导航必须注册工作台')
  assert.ok(layout.includes('ROUTE_LABELS.board'), '工作台导航文案必须引用词表')
  assert.ok(menu.includes("route: 'board'"), '手机更多菜单必须有工作台')
  assert.ok(menu.includes('ROUTE_LABELS.board'), '手机更多菜单工作台文案必须引用词表')
  assert.ok(board.includes('<PageHeader'), '工作台必须使用 PageHeader')
  assert.ok(board.includes('title="工作台"'), '工作台页头标题必须是工作台')
  for (const api of ['SessionsApi.list()', 'TasksApi.list()', 'StatsApi.providers()', 'StatsApi.daily()', 'WsApi.deliveries()', 'SubagentApi.runs()']) {
    assert.ok(board.includes(api), `工作台必须读取：${api}`)
  }
})

test('任务与会话库保留既有 API 行为', () => {
  const tasks = read('pages', 'Tasks.tsx')
  for (const api of ['TasksApi.list()', 'TasksApi.history(id)', 'TasksApi.create(body)', 'TasksApi.runNow(t.id)', "TasksApi.setState(t.id, 'pause')", "TasksApi.setState(t.id, 'resume')", "TasksApi.setState(t.id, 'archive')", 'TasksApi.stopRun(t.id)', 'TasksApi.remove(t.id)']) {
    assert.ok(tasks.includes(api), `任务中心必须保留：${api}`)
  }
  const sessionDb = read('pages', 'SessionDb.tsx')
  for (const behavior of ["api('/api/sessions/db/list')", "api('/api/sessions/db/stats')", "api('/api/sessions/db/rebuild'", "api('/api/sessions/db/sanitize'", "api('/api/sessions/db/meta'", "api('/api/sessions/db/sweep'"]) {
    assert.ok(sessionDb.includes(behavior), `会话库必须保留统一远程地址调用：${behavior}`)
  }
  assert.ok(sessionDb.includes('清理空会话'), '会话库必须提供清理空会话入口')
})

test('思考过程正文使用隔离的实底阅读面板，避免主题色层覆盖文字', () => {
  const message = read('components', 'Message.tsx')
  const styles = read('styles.css')
  assert.match(message, /className="thinking-panel"/, '展开的思考过程必须使用独立阅读面板')
  assert.match(styles, /\.thinking-panel\s*\{[^}]*isolation:\s*isolate[^}]*background:\s*var\(--pi-bg1\)[^}]*color:\s*var\(--pi-text\)/s, '思考面板必须建立独立层叠上下文并使用不透明的主题阅读底色和主文字色')
  assert.match(styles, /\.thinking-panel\s+\.markdown-body\s*\{[^}]*color:\s*inherit/s, '思考正文不得重新降级为低对比度辅助文字')
})

test('思考过程触发标签在主题底色上使用主文字色，避免同色吞字', () => {
  const message = read('components', 'Message.tsx')
  const thinkingTrigger = message.split('function Thinking')[1]?.split('function Attachments')[0] ?? ''
  assert.match(thinkingTrigger, /text-pi-text/, '思考过程文字必须从主题色切换为主文字色')
  assert.match(thinkingTrigger, /bg-pi-accent\/6/, '思考标签背景必须是轻量半透明色')
  assert.match(thinkingTrigger, /border-pi-accent\/12/, '思考标签边框必须退为低对比度提示')
  assert.match(thinkingTrigger, /hover:bg-pi-accent\/10/, '悬浮时仅作轻微反馈，不能形成主题色块')
})

test('流式中即使还没有思考/工具/正文，也要显示思考阶段，不能空白干等', () => {
  const message = read('components', 'Message.tsx')
  const assistant = message.slice(message.indexOf('const hasThinking'))
  const phaseBlock = assistant.slice(assistant.indexOf('let phase:'), assistant.indexOf('return ('))
  assert.ok(phaseBlock.includes("else phase = 'thinking'"), '流式空窗必须落到思考阶段，不能停在 idle 把工作流藏掉')
  assert.ok(phaseBlock.includes('if (streaming)'), '阶段判定只在流式中启用')
  assert.ok(!phaseBlock.includes('hasThinking && !hasTools && !hasText'), '不得要求先有思考文本才显示思考阶段')
})

test('助手配图必须在正文后面，不能插在思考过程和工具卡中间', () => {
  const message = read('components', 'Message.tsx')
  const assistant = message.slice(message.indexOf('const hasThinking'))
  const attachAt = assistant.lastIndexOf('<Attachments msg={msg} />')
  const thinkAt = assistant.lastIndexOf('<Thinking')
  const toolsAt = assistant.lastIndexOf('{msg.tools?.length')
  const mdAt = Math.max(assistant.lastIndexOf('<LazyMarkdown text={msg.text}'), assistant.lastIndexOf('<LazyMarkdown text={msg.conclusion}'))
  assert.ok(attachAt > thinkAt && attachAt > toolsAt, '配图不得出现在思考/工具卡之前，否则会被当成思考过程的图')
  assert.ok(attachAt > mdAt, '配图跟在助手正文后面')
})

test('移动更多菜单当前项在主题底色上使用主文字色，避免同色吞字', () => {
  const moreMenu = read('components', 'MobileMoreMenu.tsx')
  assert.match(moreMenu, /route === item\.route \? 'bg-pi-accent\/10 text-pi-text'/, '当前菜单项必须使用中性高对比文字色')
})

test('助手消息装饰层保持低存在感半透明，不能压过长正文', () => {
  const styles = read('styles.css')
  const assistantDecoration = styles.match(/\.msg-assistant::before\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const assistantHoverDecoration = styles.match(/\.msg-assistant:hover::before\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const assistantHover = styles.match(/\.msg-assistant:hover\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.match(assistantDecoration, /background:\s*color-mix\(in oklab, var\(--pi-accent\) 18%, transparent\)/, '助手装饰条应为低浓度半透明单色，不能使用渐变')
  assert.match(assistantDecoration, /opacity:\s*1/, '装饰透明度必须由色值统一管理')
  assert.match(assistantHoverDecoration, /opacity:\s*1/, '悬浮时不得重新加重装饰条')
  assert.match(assistantHover, /background:\s*color-mix\(in oklab, var\(--pi-accent\) 1%, transparent\)/, '长正文悬浮背景只能是近乎不可见的半透明提示')
})

test('消息视觉只使用 pi 语义色，并保留角色、Markdown、Thinking 与 ToolCard 分支', () => {
  const message = read('components', 'Message.tsx')
  assert.doesNotMatch(message, /(?:purple|sky|red|emerald)-/, 'Message 不得使用固定 purple/sky/red/emerald 色类')
  assert.doesNotMatch(message, /pi-red/, 'Message 错误状态必须使用 pi-danger')
  assert.ok(message.includes('Info'), '系统提示和通知必须使用 Lucide Info')
  assert.doesNotMatch(message, /ℹ️/, '信息提示不得使用 emoji')
  assert.doesNotMatch(message, /bg-red-/, '用户头像不得硬编码红色')
  assert.ok(message.includes("${isError ? 'border-pi-danger/40'"), '工具错误外框必须使用归一化 isError 状态')
  assert.doesNotMatch(message, /w-5 h-5[^"\n]*text-\[10px\][^"\n]*font-mono/, '工具字母/符号图标不是 badge，不得使用 10px')
  for (const branch of ['function ToolCard', 'function Thinking', 'if (isSystem)', 'if (isUser)', '<LazyMarkdown text={msg.text}', '<ToolCard']) {
    assert.ok(message.includes(branch), `消息逻辑分支必须保留：${branch}`)
  }
})

// 工坊的选择芯片（绘画/视频的光影、风格、运镜、平台那几排）改成了"选中=主色投影浮起"。
// 这里是"你做个试试"那次改动的锁：两支状态类必须在、投影必须掺主色、且**尺寸类不许被吃掉**
// （min-h-11 是触摸目标，曾经有一次差点把它们换掉）。
test('工坊选择芯片：选中=主色投影，未选中安静，触摸目标不许变小', () => {
  const css = read('styles.css')
  assert.match(css, /\.chip-pill\.is-on\s*\{[^}]*background:\s*var\(--pi-accent\)/, '选中要有主色底')
  assert.match(css, /\.chip-pill\.is-on\s*\{[^}]*box-shadow:[^}]*color-mix\(in srgb, var\(--pi-accent\)/, '选中投影要掺主色（这是"浮起来"的关键）')
  assert.match(css, /\.chip-pill\.is-on:hover[^{]*\{[^}]*translateY\(-1px\)/, '选中悬停要抬一下')
  assert.match(css, /\.chip-pill\.is-on:active[^{]*\{[^}]*translateY\(1px\)/, '选中按下要压回去')
  assert.match(css, /\.chip-pill\.is-off\s*\{[^}]*background:\s*transparent/, '没选中的保持安静')
  for (const file of [['components', 'WanXiang.tsx'], ['components', 'VideoPrompt.tsx']]) {
    const src = read(...file)
    assert.match(src, /chip-pill is-on/, `${file[1]} 的选中态要走 chip-pill is-on`)
    assert.match(src, /chip-pill is-off/, `${file[1]} 的未选中态要走 chip-pill is-off`)
    assert.doesNotMatch(src, /bg-pi-accent text-pi-on-accent border-pi-accent/, `${file[1]} 不该再自己拼选中态样式`)
    for (const m of src.matchAll(/rounded-full text-\[11px\] chip border/g)) assert.ok(m, '尺寸类要保留')
    assert.match(src, /(?:px-2\.5 min-h-11|px-2\.5 py-1|px-2 py-1) rounded-full text-\[11px\] chip border/, '尺寸/触摸目标类不许被吃掉')
  }
})
