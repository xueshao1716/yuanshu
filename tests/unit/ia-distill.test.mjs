// 评审 P1：词表同源、桌面主栏收口、⌘K 补房间、工作台先写下一步、主题目录合一
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'src')
const read = (...parts) => readFileSync(join(SRC, ...parts), 'utf8')

test('路由中文名只有一份词表，知识/创作不再三套叫法', () => {
  const nav = read('nav.ts')
  assert.ok(nav.includes("apps: '知识'"), '知识必须写在 nav.ts')
  assert.ok(nav.includes("workshop: '创作'"), '创作必须写在 nav.ts')
  assert.ok(nav.includes("models: '模型'"), '模型必须写在 nav.ts')
  assert.ok(nav.includes("lingxi: '灵感'"), '灵感必须写在 nav.ts')
  const menu = read('components', 'MobileMoreMenu.tsx')
  assert.ok(menu.includes('ROUTE_LABELS'), '手机更多必须引用词表')
  assert.ok(!menu.includes("label: '知识工具'"), '不得再叫知识工具')
  assert.ok(!menu.includes("label: '创作工坊'"), '不得再叫创作工坊')
  assert.ok(!menu.includes("label: '模型中心'"), '不得再叫模型中心')
  assert.ok(!menu.includes("label: '灵感速记'"), '不得再叫灵感速记')
  const apps = read('pages', 'Apps.tsx')
  assert.ok(apps.includes('title="知识"'), '知识页头必须叫知识')
  assert.ok(!apps.includes('title="应用中心"'), '知识页头不得再叫应用中心')
  const workshop = read('pages', 'Workshop.tsx')
  assert.ok(workshop.includes('title="创作"'), '创作页标题必须叫创作')
  const palette = read('components', 'CommandPalette.tsx')
  assert.ok(!palette.includes('打开应用中心'), '⌘K 不得再叫应用中心')
  assert.ok(palette.includes('打开知识'), '⌘K 必须叫打开知识')
})

test('桌面主栏只留对话工作台创作资产任务，其余进更多', () => {
  const nav = read('nav.ts')
  assert.ok(nav.includes("RAIL_PRIMARY"), '必须导出桌面主栏名单')
  for (const r of ["'chat'", "'board'", "'workshop'", "'assets'", "'tasks'"]) {
    assert.ok(nav.includes(r), `主栏必须包含 ${r}`)
  }
  const layout = read('AppLayout.tsx')
  const more = read('components', 'DesktopMoreMenu.tsx')
  assert.ok(layout.includes('RAIL_PRIMARY'), '桌面壳必须按主栏名单渲染')
  assert.ok(layout.includes('RAIL_MORE'), '桌面壳必须把长尾放进更多')
  assert.ok(more.includes("aria-label={moreActive ?") && more.includes(": '更多'}"), '桌面必须有可访问的更多按钮')
})

test('⌘K 能打开工作台、创作、主题、灵感、能力、会话库、系统', () => {
  const palette = read('components', 'CommandPalette.tsx')
  for (const label of ['打开工作台', '打开创作', '打开主题', '打开灵感', '打开能力', '打开会话库', '打开系统', '打开知识']) {
    assert.ok(palette.includes(label), `⌘K 缺少 ${label}`)
  }
})

test('工作台先写接下来做什么，空交付不再说交付/ 目录', () => {
  const board = read('pages', 'Board.tsx') + read('components', 'board', 'BoardWelcome.tsx') + read('components', 'board', 'BoardFocus.tsx')
  assert.ok(board.includes('data-slot="board-next"'), '工作台必须有下一步区块')
  assert.ok(board.includes('接下来做什么'), '页头或区块必须出现接下来做什么')
  assert.ok(!board.includes('交付/ 目录还是空的'), '空态不得再暴露目录名')
  assert.ok(board.includes('去创作'), '空交付必须指向创作')
})

test('主题切换器与主题页共用 THEME_CATALOG，不再各写一套', () => {
  const palettes = read('theme', 'palettes.ts')
  const switcher = read('components', 'ThemeSwitcher.tsx')
  const themes = read('pages', 'Themes.tsx')
  assert.ok(palettes.includes('export const THEME_CATALOG'), '色板必须导出 THEME_CATALOG')
  assert.ok(switcher.includes('THEME_CATALOG'), '切换器必须读目录')
  assert.ok(themes.includes('THEME_CATALOG'), '主题页必须读目录')
  assert.ok(!themes.includes('const THEME_META'), '主题页不得再手写一份 META')
  assert.ok(palettes.includes("id: 'sepia'"), '目录必须含褐纱')
  assert.ok(palettes.includes("id: 'moss'"), '目录必须含苔原')
  assert.ok(palettes.includes("id: 'azure'"), '目录必须含远岚')
  assert.ok(!palettes.includes("id: 'highLum'"), '银灰不得再单独出现在切换器目录')
  assert.ok(!palettes.includes("id: 'deep'"), '深空蓝不得再单独出现在切换器目录')
})
