import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('review shows stale checks and explicitly labels a partial file preview', () => {
  const page = read('frontend/src/pages/ReviewWorkbench.tsx');
  assert.ok(page.includes('filesTruncated'));
  assert.ok(page.includes('filesTotal'));
  assert.ok(page.includes("verification.state === 'stale'"));
  assert.ok(page.includes('verification.checks.map'));
});

test('review groups deployed asset snapshots as generated without hiding source files', () => {
  const page = read('frontend/src/pages/ReviewWorkbench.tsx')
  const body = page.split('function fileGroup(pathname: string) {')[1]?.split('\n}')[0]
  assert.ok(body, 'file grouping implementation must remain testable')
  const group = new Function('pathname', body)
  for (const file of ['public/assets/Board-Ddv9U8gE.js', 'public/assets/index-EDZ7PhXj.css', 'PUBLIC\\ASSETS\\Board-123.js', 'frontend/dist/assets/index.js']) {
    assert.equal(group(file), '生成物', file)
  }
  for (const file of ['frontend/src/pages/Board.tsx', 'engine/team-launch.mjs', 'public/app.js', 'public/assets-helper.js']) {
    assert.equal(group(file), '源码', file)
  }
  assert.equal(group('docs/release.md'), '文档')
  assert.equal(group('tmp/check.log'), '临时文件')
})

test('review workbench is wired as a route and exposes safe review states', () => {
  const page = read('frontend/src/pages/ReviewWorkbench.tsx')
  const board = read('frontend/src/pages/Board.tsx')
  const api = read('frontend/src/api.ts')
  const layout = read('frontend/src/AppLayout.tsx')
  assert.match(api, /GitReviewApi\s*=\s*\{/)
  assert.match(api, /\/api\/git\/review/)
  // 2026-09-14：改动验收并入工作台作为页内视图，因此「接入点」从 AppLayout 直接渲染
  // 改为：工作台嵌入 ReviewPanel + AppLayout 保留 review 深链别名。
  assert.match(board, /import \{ ReviewPanel \} from '\.\/ReviewWorkbench'/, '工作台必须复用改动验收面板')
  assert.match(layout, /route: 'review'/, 'review 路由必须保留（深链 / 手机更多 / 聊天右栏入口）')
  assert.match(page, /改动与验收/)
  assert.match(page, /verification\.state/)
  assert.match(page, /diffTruncated/)
  assert.match(page, /review\?\.error/)
  assert.match(page, /diffForFile|selectedDiff/)
  assert.match(page, /已阅|确认已看|acknowledge/i)
  assert.match(page, /useState/)
  assert.match(page, /AIBodyApi/)
  assert.match(page, /SubagentApi\.history/)
  assert.match(page, /review-evidence-grid/)
  assert.match(page, /review-mission-card/)
  assert.match(page, /未跟踪文件会按用途折叠/)
  assert.match(api, /\/api\/aibody/)
  assert.match(api, /\/api\/subagent\/history/)
  assert.doesNotMatch(page, /method:\s*['"]POST['"]|\/api\/git\/(reset|stage|commit)/)
})

test('改动验收并入工作台：不再是独立主栏入口，且重复板块只保留一份', () => {
  const nav = read('frontend/src/nav.ts')
  const board = read('frontend/src/pages/Board.tsx')
  const panel = read('frontend/src/pages/ReviewWorkbench.tsx')
  const layout = read('frontend/src/AppLayout.tsx')

  // 合并本身：工作台以页内视图渲染改动验收
  assert.match(board, /<ReviewPanel \/>/, '工作台必须渲染改动验收视图')
  assert.match(board, /initialView\??: BoardView|initialView = 'overview'/, '工作台必须支持预设视图（供 #/review 深链）')
  assert.match(board, /BOARD_VIEWS/, '工作台必须有视图切换清单')

  // 主栏不再单列改动验收
  const primary = nav.match(/RAIL_PRIMARY\s*=\s*\[([^\]]*)\]/)
  assert.ok(primary, '必须导出 RAIL_PRIMARY')
  assert.ok(!primary[1].includes("'review'"), '改动验收不得再作为独立主栏项')

  // 重复板块去重：RunApi.overview() 只由工作台拉一次，面板不再自己拉
  assert.ok(!/'review-run-overview'/.test(panel), '改动验收面板不得再自行拉 RunApi.overview()')
  assert.ok(!/RunApi/.test(panel), '改动验收面板不应再依赖 RunApi')
  assert.ok(!/WorkExplanationList/.test(panel), '近期工作说明必须只在工作台共享层渲染一次')

  // 深链别名仍在，且工作台仍带页头（不因合并丢掉页头契约）
  assert.match(layout, /BoardReviewPage/, '必须保留 #/review 的别名组件')
  assert.match(board, /<PageHeader/, '工作台必须使用 PageHeader')
})
