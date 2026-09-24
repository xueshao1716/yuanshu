import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { startReliabilityFixture } from './fixtures/reliability-server.mjs'
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright')
let server, origin, browser
const screenshots = new URL('../../.verification/', import.meta.url)
before(async () => {
  ;({ server, origin } = await startReliabilityFixture())
  browser = await chromium.launch({ headless: true })
  await fs.mkdir(screenshots, { recursive: true })
})
after(async () => { await browser?.close(); await server?.close() })

for (const width of [1440, 390]) test('real recovery, delivery and browser controls at ' + width + 'px', { timeout: 120000 }, async t => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 900 })
  t.after(() => context.close())
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = [], unexpected = [], writes = []
  let failDisable = true, failDownload = false
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { unexpected.push(url.origin); return route.abort() }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname.endsWith('/recovery/disable')) {
      writes.push(route.request().method())
      return route.fulfill({ status: failDisable ? 500 : 200, json: failDisable ? { error: 'fixture failure' } : { id: 'fixture-run' } })
    }
    if (url.pathname === '/api/ws/file') return route.fulfill({ status: failDownload ? 404 : route.request().headers().authorization === 'Bearer fixture-only' ? 200 : 401,
      contentType: 'text/plain', body: '本地验收测试文件' })
    unexpected.push(url.pathname); return route.abort()
  })
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('yuanshu_access_token', 'fixture-only')
  })
  await page.goto(origin + '/__reliability', { waitUntil: 'networkidle' })
  await page.getByText('检查点已保存，即将自动接续。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭自动接续', exact: true }).click()
  await page.getByRole('alert').getByText('未能关闭自动接续，请重试。', { exact: true }).waitFor()
  failDisable = false
  await page.getByRole('button', { name: '关闭自动接续', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('output').textContent === '1')
  assert.equal(await page.getByRole('button', { name: '关闭自动接续', exact: true }).count(), 0)
  assert.deepEqual(writes, ['POST', 'POST'])
  await page.getByRole('link', { name: '打开改动验收', exact: true }).click()
  assert.equal(new URL(page.url()).hash, '#/review')
  for (const [state, label] of [['ready_to_publish', '已人工验收'], ['acceptance_stale', '文件已变化'], ['unverified', '暂不能确认验收状态']]) {
    await page.getByLabel('验收测试状态', { exact: true }).selectOption(state)
    await page.locator('[aria-label="天团交付验收"]').getByText(label, { exact: false }).waitFor()
  }
  await page.getByLabel('验收测试状态', { exact: true }).selectOption('awaiting_acceptance')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow')
  await page.screenshot({ path: fileURLToPath(new URL('reliability-' + width + '.png', screenshots)), fullPage: true })
  await page.getByRole('button', { name: '打开测试浏览器', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '内置浏览器', exact: true })
  await page.frameLocator('iframe').getByText('本地测试内容', { exact: true }).waitFor()
  assert.equal((await dialog.boundingBox()).width, width < 900 ? width : 760)
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-forms allow-modals allow-popups allow-presentation allow-scripts')
  const address = page.getByRole('textbox', { name: '浏览器地址', exact: true })
  await address.fill('javascript:alert(1)'); await address.press('Enter')
  await page.getByText('只支持 http(s) 链接', { exact: true }).waitFor()
  assert.equal(await page.locator('iframe').getAttribute('src'), origin + '/fixture/one')
  await address.fill(origin + '/fixture/two'); await address.press('Enter')
  await page.getByRole('button', { name: '后退', exact: true }).click()
  assert.equal(await address.inputValue(), origin + '/fixture/one')
  await page.getByRole('button', { name: '前进', exact: true }).click()
  assert.equal(await address.inputValue(), origin + '/fixture/two')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: '复制当前地址', exact: true }).click()
  await page.getByText('地址已复制', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), origin + '/fixture/two')
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied') }; document.execCommand = () => false })
  await page.getByRole('button', { name: '复制当前地址', exact: true }).click()
  await page.getByText('复制失败，请长按地址栏选择复制', { exact: true }).waitFor()
  await page.clock.install()
  await address.fill(origin + '/fixture/hang'); await address.press('Enter')
  await page.clock.fastForward(16000)
  await page.getByRole('alert').getByText('页面加载较慢', { exact: false }).waitFor()
  await page.screenshot({ path: fileURLToPath(new URL('browser-' + width + '.png', screenshots)), fullPage: true })
  await page.getByRole('button', { name: '刷新页面', exact: true }).click()
  await page.getByRole('alert').waitFor({ state: 'detached' })
  await page.getByText('正在加载页面…', { exact: true }).waitFor()
  await page.getByRole('button', { name: '回到元枢工作台', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.waitForFunction(() => !history.state?.__yuanshuBrowserPanel)
  await page.getByRole('button', { name: '打开测试浏览器', exact: true }).click()
  await page.goBack(); await dialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '打开测试浏览器', exact: true }).click()
  await page.getByRole('button', { name: '在当前窗口打开', exact: true }).click()
  await page.waitForURL(origin + '/fixture/one')
  await page.goBack(); await page.getByRole('button', { name: '打开测试浏览器', exact: true }).waitFor()
  const fileRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/ws/file')
  const fileDownload = page.waitForEvent('download')
  await page.getByText('下载草稿', { exact: true }).click()
  const request = await fileRequest
  assert.equal(request.headers().authorization, 'Bearer fixture-only', 'delivery download must use authenticated file access')
  assert.ok(!request.url().includes('token='), 'token must not leak into file URL')
  const downloaded = await fileDownload
  assert.equal(downloaded.suggestedFilename(), '草稿.md')
  assert.equal(await fs.readFile(await downloaded.path(), 'utf8'), '本地验收测试文件')
  failDownload = true
  await page.getByRole('button', { name: '下载核验记录', exact: true }).click()
  await page.getByRole('alert').getByText('原文件已不存在', { exact: false }).waitFor()
  assert.deepEqual(errors, [], 'no unhandled page errors')
  assert.deepEqual(unexpected, [], 'no production API or external requests')
})
