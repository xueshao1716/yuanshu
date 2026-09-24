// 创作工坊：AI 绘画与万像出图合一——万像写提示词，绘画框真正出图
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'src')
const read = (...parts) => readFileSync(join(SRC, ...parts), 'utf8')

test('创作工坊不再把万像出图当成独立页签', () => {
  const workshop = read('pages', 'Workshop.tsx')
  assert.ok(workshop.includes("'image'") && workshop.includes("'video'") && workshop.includes("'ppt'") && workshop.includes("'novel'") && workshop.includes("'ui'"), '页签是出图 / 视频 / PPT / 小说 / 界面')
  assert.ok(!workshop.includes("['wanxiang'"), '不得再有独立 wanxiang 页签')
  assert.ok(!workshop.includes('万像出图'), '不得再把万像当成并列页签名')
  assert.ok(workshop.includes('AI 绘画'), '出图页签仍叫 AI 绘画')
})

test('旧的万像页签会迁到 AI 绘画', () => {
  const workshop = read('pages', 'Workshop.tsx')
  assert.ok(workshop.includes("saved === 'wanxiang'"), '读到旧 tab=wanxiang 必须改走出图')
})

test('选模型在各工坊内部，不跟顶级页签放一起', () => {
  const workshop = read('pages', 'Workshop.tsx')
  const ppt = read('components', 'WorkshopView.tsx')
  const bench = read('components', 'novel', 'NovelWorkbench.tsx')
  const gen = read('components', 'GeneratePanel.tsx')
  assert.ok(!workshop.includes('ModelSelect'), '顶级页签旁不得放选模型')
  assert.ok(gen.includes('imageModels') && gen.includes('<select'), '绘图工坊内必须能选出图模型')
  assert.ok(ppt.includes('WorkshopModelPicker'), 'PPT 工坊内必须能选文本模型')
  assert.ok(bench.includes('WorkshopModelPicker'), '小说工坊内必须能选文本模型')
})

test('出图页把万像提示词填进绘画框', () => {
  const workshop = read('pages', 'Workshop.tsx')
  const wanxiang = read('components', 'WanXiang.tsx')
  const generate = read('components', 'GeneratePanel.tsx')
  assert.ok(workshop.includes('<GeneratePanel'), '出图页必须有绘画框')
  assert.ok(workshop.includes('<WanXiang'), '出图页必须嵌万像')
  assert.ok(workshop.includes('onUsePrompt'), '工坊必须把提示词接到绘画框')
  assert.ok(wanxiang.includes('onUsePrompt'), '万像必须能交出提示词')
  assert.ok(wanxiang.includes('填入出图框'), '万像必须有填入出图框')
  assert.ok(generate.includes('onPromptChange'), '绘画框必须能受控填入提示词')
  assert.ok(generate.includes('智能填充') || generate.includes('expandPrompt') || generate.includes('PromptSmartFill'), '绘画框要能智能扩写短句')
  assert.ok(wanxiang.includes('composeImagePrompt'), '万像必须用成句组词，不能只顿号拼接')
  assert.ok(wanxiang.includes('PromptSmartFill') || wanxiang.includes('智能填充'), '万像也要能按一句话填表')
})

test('新版网站工坊保留官方 M3E Canvas 旧作品入口', () => {
  const workshop = read('pages', 'Workshop.tsx')
  const board = read('components', 'LegacyUiBoard.tsx')
  assert.ok(read('components', 'WorkshopUiBoard.tsx').includes('WebsiteBoard'), '主入口使用可视网站工坊')
  assert.ok(read('components', 'website', 'WebsiteBoard.tsx').includes('LegacyUiBoard'), '旧作品入口仍可达')
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'workshop-ui', 'index.html'), 'utf8')
  assert.ok(workshop.includes("tab === 'ui'"), '点界面工坊必须有内容分支')
  assert.ok(workshop.includes('<WorkshopUiBoard'), '页签要接到草图板组件，不能只画空框')
  assert.ok(index.includes('_next'), '必须是官方 Next 静态导出，不能是自绘壳')
  assert.ok(!index.includes('M3E 草图板 v0.1'), '不得再是自绘 v0.1')
  assert.ok(board.includes('/static/workshop-ui/'), '入口仍走静态目录')
  assert.ok(!board.includes('srcDoc'), '官方 Next 不能塞进 srcDoc')
  const entry = read('lib', 'ui-design-api.ts')
  assert.ok(entry.includes('location.assign'), '作品明确点击后整页打开官方画布')
  assert.ok(board.includes('vanilla='), '现网 CSP 只对 vanilla= 放行内联脚本')
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.mjs'), 'utf8')
  assert.ok(server.includes('/static/workshop-ui'), '服务端必须认出草图板路径')
  assert.ok(server.includes("frame-ancestors 'self'") && server.includes('SAMEORIGIN'), '草图板必须允许被本站 iframe，不能 DENY')
  assert.ok(server.includes("unsafe-inline") && server.includes('workshop-ui'), '官方 Next 导出需要本路径放行内联脚本')
})

test('官方画布必须套元枢壳：有返回、有字号缩放、藏掉上游 GitHub', () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'workshop-ui', 'index.html'), 'utf8')
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'workshop-ui', 'yuanshu-shell.css'), 'utf8')
  const js = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'workshop-ui', 'yuanshu-shell.js'), 'utf8')
  assert.ok(index.includes('yuanshu-shell.css') && index.includes('yuanshu-shell.js'), '官方 HTML 必须挂上元枢壳')
  assert.ok(css.includes('--yuanshu-scale: 0.85') && css.includes('--yuanshu-scale: 1'), '桌面适度缩放，手机保持触控字号')
  assert.ok(!css.includes('zoom:'), '禁止用 CSS zoom 缩放整页，会把官方右侧提示词栏挤出窗口')
  assert.ok(css.includes('transform: scale') && css.includes('100vw'), '用 transform + vw 缩小，右侧提示词栏必须还在视口里')
  assert.ok(css.includes('lnkiai/m3e-canvas') && css.includes('display: none'), '上游 GitHub 入口必须藏掉')
  assert.ok(js.includes('返回创作') && js.includes('元枢'), '顶栏必须有元枢字样和回创作')
  assert.ok(js.includes('#/workshop'), '返回必须进创作页')
  assert.ok(js.includes('pi_workshop_tab'), '返回前必须改掉记住的界面工坊页签，否则创作页一挂载又整页跳回来')
  assert.ok(js.includes("setItem('pi_workshop_tab'") || js.includes('setItem("pi_workshop_tab"'), '必须把页签写成非 ui')
})

test('官方画布必须套元枢主题和元枢模型，不能再让人填 OpenAI Key', () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'workshop-ui', 'index.html'), 'utf8')
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'workshop-ui', 'yuanshu-shell.css'), 'utf8')
  const js = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'workshop-ui', 'yuanshu-shell.js'), 'utf8')
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.mjs'), 'utf8')
  assert.ok(index.includes('yuanshu-shell.js'), '壳脚本必须挂上')
  assert.ok(css.includes('--pi-bg') && css.includes('yuanshu-wallpaper'), '画布背景要走元枢主题/壁纸')
  assert.ok(css.includes('#yuanshu-bar') && css.includes('var(--pi-bg,') && css.includes('var(--pi-accent,'), '顶栏必须跟元枢主题色，不能写死深蓝灰')
  assert.ok(!/#yuanshu-bar[\s\S]{0,400}background:\s*#181b20/.test(css), '顶栏不得再写死 #181b20')
  assert.ok(js.includes('pi_theme') && js.includes('pi_wallpaper'), '必须读元枢主题和壁纸')
  assert.ok(js.includes('m3e:ai') && js.includes('/api/workshop-ui/v1'), '官方 AI 必须注入元枢兼容端点')
  assert.ok(js.includes('/api/models') && js.includes('yuanshu-model'), 'AI 面板要列出元枢文本模型')
  assert.ok(js.includes('yuanshu-ai-panel') && js.includes('AI 设置'), '官方 AI 设置不能只剩空标题，要补上元枢模型')
  assert.ok(js.includes('让 AI 来画'), 'AI 设置里要写明辅助设计入口在画布上')
  assert.ok(server.includes('/api/workshop-ui/v1/chat/completions'), '服务端必须有官方画布用的兼容 completions')
})

test('界面工坊不得在创作页一恢复就整页跳走', () => {
  const workshop = read('pages', 'Workshop.tsx')
  const board = read('components', 'LegacyUiBoard.tsx')
  const website = read('components', 'website', 'WebsiteBoard.tsx')
  assert.ok(!workshop.includes('yuanshu-open-ui'), '页签只打开作品列表，不能触发自动导航')
  assert.ok(board.includes('新建界面作品') && board.includes('已有作品'), '返回作品管理页后才能明确选择画布')
  assert.ok(!/useEffect\(\(\) => \{\s*window\.location\.(replace|assign)/.test(board), '不得无条件 replace/assign，否则返回创作会弹回')
  assert.ok(!website.includes('window.location'), '新编辑器在工坊内打开，不整页跳转')
})

test('创作三板块手机版：页签铺满、触控 44px、表单可竖排', () => {
  const workshop = read('pages', 'Workshop.tsx')
  const ppt = read('components', 'WorkshopView.tsx')
  const gen = read('components', 'GeneratePanel.tsx')
  const shelf = read('components', 'novel', 'NovelShelf.tsx')
  const bench = read('components', 'novel', 'NovelWorkbench.tsx')
  assert.ok(workshop.includes('data-slot="workshop-tabs"'), '页签必须有稳定槽位')
  assert.ok(workshop.includes('grid-cols-2') && workshop.includes('min-h-11'), '手机页签两列铺满且触控不少于 44px')
  assert.ok(workshop.includes('<PageHeader'), '创作页必须用公共页头')
  assert.ok(gen.includes('w-full sm:w-auto') || gen.includes('min-h-11'), '出图主按钮手机上要好按')
  assert.ok(ppt.includes('min-h-11') && ppt.includes('w-full sm:w-auto'), 'PPT 开始按钮手机铺满')
  assert.ok(!ppt.includes('🎨') && !ppt.includes('📄'), '引擎切换不得用 emoji 当标签')
  assert.ok(shelf.includes('overflow-x-auto') && shelf.includes('min-h-11'), '小说书架筛选条可横滑且触控足够')
  assert.ok(bench.includes('data-slot="novel-pipeline"') && bench.includes('min-h-11'), '小说管道节点手机触控足够')
})
