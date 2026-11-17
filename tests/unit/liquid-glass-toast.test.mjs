// 2026-11-17 通知改「灵动胶囊」（单容器原地变形、同类合并、进度原地推进）+ 浮层液态玻璃
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMPTY, ERROR_HOLD_MS, pushToast, expireToast, dismissToast, nextDelay } from '../../frontend/src/lib/toast-queue.mjs'
import { buildLiquidFilter, refractionSupported } from '../../frontend/src/lib/liquid-glass.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFileSync(join(ROOT, 'frontend', 'src', ...p), 'utf8')
let id = 0
const push = (s, input, now = 0) => pushToast(s, { id: ++id, ...input }, now)

test('同一句话连续出现：不新开，原地计数 ×N 并重新计时', () => {
  let s = push(EMPTY, { msg: '已复制', tone: 'ok' }, 0)
  s = push(s, { msg: '已复制', tone: 'ok' }, 1000)
  s = push(s, { msg: '已复制', tone: 'ok' }, 1500)
  assert.equal(s.cur.count, 3)
  assert.equal(s.shownAt, 1500)
  assert.equal(s.queue.length, 0)
})

test('带 key 的任务：同一个胶囊里更新文字和进度，不计数', () => {
  let s = push(EMPTY, { msg: '摘要生成中 0/5', key: 'sum', progress: 0, sticky: true }, 0)
  const first = s.cur.id
  s = push(s, { msg: '摘要生成中 3/5', key: 'sum', progress: 0.6, sticky: true }, 500)
  assert.equal(s.cur.id, first)
  assert.equal(s.cur.msg, '摘要生成中 3/5')
  assert.equal(s.cur.progress, 0.6)
  assert.equal(s.cur.count, 1)
  assert.equal(nextDelay(s, 600), Infinity, '常驻任务不自动消失')
  s = push(s, { msg: '摘要完成', key: 'sum', tone: 'ok' }, 900)
  assert.equal(s.cur.sticky, false)
  assert.equal(nextDelay(s, 900), 3000)
})

test('普通消息直接替换；报错至少停留 ERROR_HOLD_MS，后来的排队', () => {
  let s = push(EMPTY, { msg: 'a' }, 0)
  s = push(s, { msg: 'b' }, 100)
  assert.equal(s.cur.msg, 'b')
  s = push(s, { msg: '失败了', tone: 'error' }, 200)
  s = push(s, { msg: 'c' }, 300)
  assert.equal(s.cur.msg, '失败了')
  assert.deepEqual(s.queue.map(x => x.msg), ['c'])
  assert.equal(nextDelay(s, 300), ERROR_HOLD_MS - 100, '有排队时报错停满保底时间就让位')
  s = expireToast(s, 2700)
  assert.equal(s.cur.msg, 'c')
  s = expireToast(s, 6000)
  assert.equal(s.cur, null)
})

test('dismiss 按 key 收起当前或移出队列', () => {
  let s = push(EMPTY, { msg: 'x', key: 'k1', sticky: true }, 0)
  s = dismissToast(s, 'k1', 10)
  assert.equal(s.cur, null)
})

test('液态玻璃滤镜：按尺寸生成位移图，三通道错位做色散', () => {
  const f = buildLiquidFilter('lg1', 320, 48, 24)
  assert.match(f, /<filter id="lg1"/)
  assert.equal((f.match(/<feDisplacementMap/g) || []).length, 3)
  assert.match(f, /<feImage[^>]*href="data:image\/svg\+xml/)
  assert.match(f, /width="320"/)
  assert.doesNotMatch(f, /NaN|undefined/)
})

test('折射只在 Chromium 内核开启，其他浏览器退回毛玻璃', () => {
  assert.equal(refractionSupported('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), true)
  assert.equal(refractionSupported('Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0'), false)
  assert.equal(refractionSupported('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'), false)
})

test('通知与命令面板接上液态玻璃；减少透明度时退回实底', () => {
  const toast = read('components', 'shell', 'Toast.tsx')
  assert.ok(toast.includes('toast-queue.mjs') && toast.includes('useLiquidGlass'), '通知走队列 + 液态玻璃')
  assert.ok(!toast.includes('items.map'), '不再多条堆叠')
  assert.ok(read('components', 'shell', 'CommandPalette.tsx').includes('liquid-glass'), '命令面板用液态玻璃')
  const css = read('styles.css')
  assert.match(css, /prefers-reduced-transparency:\s*reduce\)[\s\S]{0,200}\.liquid-glass/, '减少透明度要退回实底')
  assert.match(css, /prefers-reduced-motion:\s*reduce\)[\s\S]{0,200}\.pi-island/, '减弱动画时胶囊不弹')
})

test('液态玻璃主题：浮层控件自动挂折射，背景有可透的彩光，玻璃有亮边', async () => {
  const { THEME_GLASS_SELECTORS } = await import('../../frontend/src/lib/liquid-glass.mjs')
  for (const s of ['.sendbox-shell', '.workstart-command', '.btn-primary', '.desktop-rail-item[aria-current="page"]']) {
    assert.ok(THEME_GLASS_SELECTORS.includes(s), `主题里 ${s} 要挂折射`)
  }
  assert.ok(read('AppLayout.tsx').includes('useThemeLiquidGlass('), '公共布局挂主题折射')
  const css = read('styles.css')
  const theme = css.slice(css.indexOf('液态玻璃主题 v2'))
  assert.ok(theme.length > 100, '主题要有 v2 段')
  assert.ok((theme.match(/radial-gradient/g) || []).length >= 4, '背景至少 4 团彩光，玻璃才有东西可透')
  assert.match(theme, /inset 0 1px 0 rgba\(255, ?255, ?255, ?\.9/, '玻璃顶边要有亮线')
})
