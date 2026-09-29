// Regression: main chat opens a consent-gated call view, never the local-only lab.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '../..')
const dist = path.join(root, process.env.YUANSHU_VOICE_DIST || 'tmp/verification-dist')
const sid = 'isolated-voice-entry', now = new Date().toISOString()
const browser = await chromium.launch({ headless: true })
try {
  for (const [base, width] of [['http://127.0.0.1:8787', 1440], ['http://127.0.0.1:8787', 390], ['https://remote.invalid', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 })
    const errors = [], requests = []
    await context.routeWebSocket('**/*', ws => ws.close())
    await context.route('**/*', async route => {
      const u = new URL(route.request().url())
      requests.push({ url: u.href, method: route.request().method() })
      if (u.origin === 'http://127.0.0.1:8788') return route.fulfill({ contentType: 'text/html', body: '<h1>Isolated lab destination</h1>' })
      if (u.origin !== base) return route.abort()
      const json = value => route.fulfill({ json: value })
      if (u.pathname === '/api/sessions') return json({ sessions: [{ id: sid, name: '入口隔离验收', updatedAt: now }] })
      if (u.pathname === `/api/sessions/${sid}/messages`) return json({ messages: [
        { id: 'u1', role: 'user', text: '检查入口', ts: now },
        { id: 'a1', role: 'assistant', text: '用于验证停止朗读。', ts: now },
      ], truncated: false })
      if (u.pathname === '/api/tts/capabilities') return json({ available: false, reason: 'isolated test' })
      if (u.pathname === '/api/run/overview') return json({ active: [], recent: [] })
      if (u.pathname.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {"lastSeq":0}\n\n' })
      if (u.pathname.startsWith('/api/')) return json({})
      const file = path.resolve(dist, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).slice(1))
      if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' })
      return route.fulfill({ path: file, contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' })
    })
    await context.addInitScript(({ sid }) => {
      localStorage.setItem('yuanshu_access_token', 'fixture-only')
      localStorage.setItem('pi_last_session', sid)
      window.__entryAudio = { cancelled: 0, requested: 0, stopped: 0 }
      Object.defineProperty(window, 'speechSynthesis', { value: {
        getVoices: () => [{ lang: 'zh-CN' }], cancel() { window.__entryAudio.cancelled++ }, pause() {}, resume() {},
        speak(utterance) { setTimeout(() => utterance.onstart?.(), 0) },
      } })
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        window.__entryAudio.requested++
        return { getTracks: () => [{ stop() { window.__entryAudio.stopped++ } }] }
      } })
      window.MediaRecorder = class {
        static isTypeSupported() { return true }
        start() {} stop() { setTimeout(() => this.onstop?.(), 0) }
      }
    }, { sid })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base + '/#/chat', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '朗读回复', exact: true }).waitFor()
    assert.equal(await page.getByText('实时语音 · 本机试用', { exact: true }).count(), 0)
    const panel = page.getByRole('region', { name: '实时通话', exact: true })
    const entry = page.getByRole('button', { name: '语音通话', exact: true })
    await entry.click()
    const start = panel.getByRole('button', { name: '开始通话', exact: true })
    assert.equal(await start.isEnabled(), false)
    assert.equal(await page.evaluate(() => window.__entryAudio.requested), 0)
    await panel.getByRole('checkbox').check()
    assert.equal(await start.isEnabled(), true)
    await panel.getByRole('button', { name: '返回聊天', exact: true }).click()
    await page.getByRole('button', { name: '语音输入', exact: true }).click()
    await page.getByRole('button', { name: '取消录音', exact: true }).waitFor()
    assert.equal(await entry.isEnabled(), false)
    await page.getByRole('button', { name: '取消录音', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-voice-entry]')?.disabled === false)
    assert.equal(await page.evaluate(() => window.__entryAudio.requested), 1, 'only explicit recording requested mic')
    assert.equal(context.pages().length, 1, 'call entry never opens the local lab')
    const bounds = await entry.boundingBox()
    assert.ok(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(errors, [])
    assert.equal(requests.some(request => request.method !== 'GET'), false)
    console.log(JSON.stringify({ base, width, passed: true, noLiveNetwork: true }))
    await context.close()
  }
} finally { await browser.close() }
