// Uses only the isolated frontend build, synthetic APIs and local fixture pages.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { baseFixture } from '../helpers/cultivation-observation-browser.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dist = path.join(root, 'tmp/verification-dist')
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname === '/fixture' || pathname === '/blocked') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(pathname === '/blocked' ? { 'Content-Security-Policy': "frame-ancestors 'none'" } : {}) })
    return res.end('<!doctype html><title>Browser fixture</title><h1>页面可读</h1><button onclick="this.textContent=\'点击有效\'">测试交互</button>')
  }
  const file = path.resolve(dist, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)))
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROME_PATH ? { executablePath: process.env.YUANSHU_CHROME_PATH } : {}) })
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    const page = await context.newPage(), errors = []
    page.setDefaultTimeout(12000)
    page.on('pageerror', error => errors.push(error.message))
    await page.routeWebSocket('**/*', ws => ws.close())
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: baseFixture(url.pathname) })
      return route.continue()
    })
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('yuanshu_access_token', 'synthetic-browser-token')
      localStorage.setItem('pi_last_session', 'fixture')
      localStorage.setItem('yuanshu_companion_hidden', 'true')
    })
    await page.goto(origin + '/#/soul')
    await page.getByRole('heading', { name: '灵魂培养中心', exact: true }).waitFor()
    await page.evaluate(url => window.dispatchEvent(new CustomEvent('pi-open-browser', { detail: { url } })), origin + '/fixture')
    const dialog = page.getByRole('dialog', { name: '内置浏览器', exact: true })
    await dialog.waitFor()
    const frame = page.frameLocator('iframe[title="内置浏览器页面"]')
    await frame.getByRole('heading', { name: '页面可读' }).waitFor()
    await frame.getByRole('button', { name: '测试交互' }).click()
    await frame.getByRole('button', { name: '点击有效' }).waitFor()
    const parentUrl = page.url()
    const popupWait = page.waitForEvent('popup')
    await dialog.getByRole('button', { name: '在浏览器中打开', exact: true }).click()
    const popup = await popupWait
    await popup.waitForURL(origin + '/fixture')
    assert.equal(await popup.evaluate(() => window.opener), null)
    assert.equal(page.url(), parentUrl)
    await popup.close()
    const address = dialog.getByRole('textbox', { name: '浏览器地址' })
    await address.fill('/blocked'); await address.press('Enter')
    await page.waitForFunction(() => document.querySelector('iframe')?.src.endsWith('/blocked'))
    await dialog.getByText('这里提供隔离网页预览。', { exact: false }).waitFor()
    await page.evaluate(() => { window.open = () => null })
    await dialog.getByRole('button', { name: '在浏览器中打开', exact: true }).click()
    await dialog.getByRole('alert').getByText('新窗口被浏览器拦截', { exact: false }).waitFor()
    assert.equal(page.url(), parentUrl)
    await address.fill('javascript:alert(1)'); await address.press('Enter')
    await dialog.getByRole('status').getByText('只支持 http(s) 链接').waitFor()
    assert.equal(await page.locator('iframe').getAttribute('src'), origin + '/blocked')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow')
    await page.screenshot({ path: path.join(root, `tmp/browser-panel-${width}.png`) })
    await dialog.getByRole('button', { name: '回到元枢工作台' }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ width, preview: 'interactive', externalOpen: 'isolated', blockedPopup: 'actionable', errors }))
    await context.close()
  }
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
