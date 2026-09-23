import assert from 'node:assert/strict'
import fs from 'node:fs'
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.YUANSHU_FRONTEND_URL || 'http://127.0.0.1:8787'
const token = fs.readFileSync(new URL('../../.token', import.meta.url), 'utf8').trim()
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [390, 820, 1440]) {
    const mobile = width < 900
    const context = await browser.newContext({ viewport: { width, height: 844 } })
    const page = await context.newPage()
    await page.routeWebSocket('**/*', ws => ws.close())
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      const json = value => route.fulfill({ json: value })
      if (route.request().method() !== 'GET') return json({ error: 'read-only layout test' })
      if (path === '/api/sessions') return json({ sessions: [] })
      if (path === '/api/run/overview') return json({ active: [], recent: [] })
      return route.continue()
    })
    await page.addInitScript(token => {
      localStorage.setItem('yuanshu_access_token', token)
      localStorage.setItem('pi_right_panel', 'workspace')
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.dataset.appShell = '1'
      })
    }, token)
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    const panel = page.getByRole('complementary', { name: '辅助工具面板' })
    await panel.waitFor()
    const bounds = await panel.boundingBox()
    if (!mobile) {
      assert.ok(bounds.width >= 348 && bounds.width <= 448, '桌面保持侧栏宽度')
    } else {
      assert.equal(bounds.x, 0, '手机面板从屏幕左边开始')
      assert.equal(bounds.y, 0, '手机面板覆盖顶部安全区背景')
      assert.equal(bounds.width, width, '手机面板占满屏幕宽度')
      assert.equal(bounds.height, 844, '手机面板占满可见高度')
      assert.ok(await panel.evaluate(el => el.contains(document.elementFromPoint(innerWidth / 2, innerHeight - 10))), '底部导航不能盖在辅助面板上')
      const close = page.getByRole('button', { name: '关闭辅助工具面板', exact: true })
      const closeBounds = await close.boundingBox()
      assert.ok(closeBounds.y >= 28, '原生壳关闭按钮避开状态栏')
      assert.ok(closeBounds.height >= 44, '关闭按钮可触控')
      for (const name of ['检查', '交付物', '活动', '终端', 'TUI', '工作区']) {
        await panel.getByRole('tab', { name, exact: true }).click()
        assert.equal((await panel.boundingBox()).width, width)
      }
      // A resized visual viewport models the space remaining above the keyboard.
      await page.setViewportSize({ width, height: 480 })
      await page.waitForFunction(() => Math.abs(document.querySelector('.utility-panel').getBoundingClientRect().height - 480) < 1)
      await close.click()
      await panel.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: '更多', exact: true }).click()
      await page.getByRole('button', { name: '工作空间', exact: true }).click()
      await panel.waitFor()
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
      assert.equal(await page.locator('.mobile-tab-bar').getAttribute('inert'), null, '关闭后导航恢复交互')
    }
    console.log(JSON.stringify({ width, fullscreen: mobile, closeAndReopen: mobile ? 'passed' : 'not-applicable' }))
    await context.close()
  }
} finally { await browser.close() }
