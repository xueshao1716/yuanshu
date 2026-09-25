import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js'
const cache = path.join(process.env.LOCALAPPDATA, 'ms-playwright')
const executablePath = fs.readdirSync(cache).filter(x => x.startsWith('chromium-')).reverse().flatMap(x => ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'].map(y => path.join(cache, x, y))).find(fs.existsSync)
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-chat-media-'))
process.chdir(path.resolve('frontend'))
const server = await createServer({ root: process.cwd(), server: { port: 0 }, plugins: [{ name: 'media-test-page', configureServer(s) {
  s.middlewares.use('/__media-test', async (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(await s.transformIndexHtml('/__media-test', '<html><head></head><body><div id="root"></div><script type="module" src="/test/chat-media-fixture.tsx"></script></body></html>'))
  })
} }] })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, executablePath })
try {
  for (const mobile of [false, true]) {
    const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, acceptDownloads: true })
    await ctx.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }) })
    const p = await ctx.newPage()
    p.setDefaultTimeout(15000)
    const errors = []
    p.on('pageerror', e => errors.push(e.message))
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    let fail = false
    let webm
    await p.route('**/api/ws/file?**', route => route.fulfill(fail ? { status: 404, contentType: 'application/json', body: '{"error":"测试文件不存在"}' } : { status: 200, contentType: route.request().url().includes('webm') ? 'video/webm' : 'image/png', body: route.request().url().includes('webm') ? webm : png }))
    // Generate a real local video fixture with browser MediaRecorder, no production files.
    await p.route('**/__media-blank', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }))
    await p.goto(`${base}/__media-blank`)
    webm = Buffer.from(await p.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#376f85'; ctx.fillRect(0, 0, 640, 360)
      const stream = canvas.captureStream(10), recorder = new MediaRecorder(stream, { mimeType: 'video/webm' }), chunks = []
      return await new Promise(resolve => { recorder.ondataavailable = e => chunks.push(e.data); recorder.onstop = async () => { stream.getTracks().forEach(t => t.stop()); resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))) }; recorder.start(); setTimeout(() => recorder.stop(), 250) })
    }))
    await p.goto(`${base}/__media-test`)
    await p.getByRole('button', { name: '查看大图 图片1' }).first().click()
    const dialog = p.getByRole('dialog')
    await dialog.getByText('1 / 3', { exact: true }).waitFor()
    const historyLength = await p.evaluate(() => history.length)
    const [imageDownload] = await Promise.all([p.waitForEvent('download'), dialog.getByRole('button', { name: '保存原图' }).click()])
    assert.equal(imageDownload.suggestedFilename(), '海报.png')
    const imagePath = path.join(artifacts, `${mobile ? 'mobile' : 'desktop'}.png`)
    await imageDownload.saveAs(imagePath)
    assert.deepEqual(fs.readFileSync(imagePath), png)
    assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('yuanshu_download_history_v1'))[0].status), 'started')
    await dialog.getByRole('button', { name: '下一项素材' }).click()
    await dialog.getByText('2 / 3', { exact: true }).waitFor()
    const [videoDownload] = await Promise.all([p.waitForEvent('download'), dialog.getByRole('button', { name: '保存视频' }).click()])
    await videoDownload.saveAs(path.join(artifacts, `${mobile ? 'mobile' : 'desktop'}.webm`))
    assert.equal(videoDownload.suggestedFilename(), '短片.webm')
    assert.deepEqual(fs.readFileSync(await videoDownload.path()), webm)
    await p.keyboard.press('ArrowRight')
    await dialog.getByText('3 / 3', { exact: true }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '下一项素材' }).isDisabled(), true)
    assert.equal(await p.evaluate(() => history.length), historyLength, 'rerenders must not push additional history')
    if (mobile) {
      const image = dialog.locator('img')
      await image.evaluate(el => {
        el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: el, clientX: 40, clientY: 300 })] }))
        el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [new Touch({ identifier: 1, target: el, clientX: 200, clientY: 310 })] }))
      })
      await dialog.getByText('2 / 3', { exact: true }).waitFor()
      await dialog.locator('video').evaluate(el => {
        const y = el.getBoundingClientRect().bottom - 10
        el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: el, clientX: 200, clientY: y })] }))
        el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [new Touch({ identifier: 1, target: el, clientX: 40, clientY: y })] }))
      })
      await dialog.getByText('2 / 3', { exact: true }).waitFor()
      await dialog.locator('video').evaluate(el => {
        const box = el.getBoundingClientRect(), y = box.top + 10
        el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: el, clientX: 200, clientY: y })] }))
        el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [new Touch({ identifier: 1, target: el, clientX: 40, clientY: y })] }))
      })
      await dialog.getByText('3 / 3', { exact: true }).waitFor()
    }
    await p.screenshot({ path: path.join(artifacts, `${mobile ? 'mobile' : 'desktop'}-viewer.png`) })
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await dialog.getByRole('button', { name: '保存原图' }).evaluate(el => {
      const box = el.getBoundingClientRect()
      return box.width >= 44 && box.height >= 44 && box.top >= 0 && box.bottom <= innerHeight
    }), true)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await p.getByRole('button', { name: '全屏查看视频1' }).click()
    await dialog.getByText('2 / 3', { exact: true }).waitFor()
    await p.evaluate(() => history.back())
    await dialog.waitFor({ state: 'detached' })
    await p.getByRole('button', { name: '查看大图 图片1' }).first().click()
    fail = true
    await dialog.getByRole('button', { name: '保存原图' }).click()
    await dialog.getByRole('alert').filter({ hasText: '测试文件不存在' }).waitFor()
    fail = false
    await p.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException('cancel', 'AbortError') } })
    await dialog.getByRole('button', { name: '保存原图' }).click()
    await dialog.getByRole('alert').filter({ hasText: '已取消保存' }).waitFor()
    await p.evaluate(() => {
      window.__savedBytes = null
      window.__writerClosed = false
      window.showSaveFilePicker = async () => ({ createWritable: async () => ({
        write: async blob => { window.__savedBytes = Array.from(new Uint8Array(await blob.arrayBuffer())) },
        close: async () => { window.__writerClosed = true }, abort: async () => {},
      }) })
    })
    await dialog.getByRole('button', { name: '保存原图' }).click()
    await dialog.getByRole('status').filter({ hasText: '已保存到所选位置' }).waitFor()
    assert.deepEqual(await p.evaluate(() => window.__savedBytes), [...png])
    assert.equal(await p.evaluate(() => window.__writerClosed), true)
    assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('yuanshu_download_history_v1'))[0].status), 'saved')
    await p.getByRole('button', { name: '切换测试会话' }).evaluate(el => el.click())
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await p.getByRole('button', { name: '查看大图 图片1' }).count(), 0)
    assert.deepEqual(errors, [])
    await ctx.close()
    console.log(`${mobile ? 'mobile' : 'desktop'}: exact image/video download bytes, navigation, boundaries, history, errors, cancellation passed`)
  }
  console.log('artifacts', artifacts)
} finally { await browser.close(); await server.close() }
