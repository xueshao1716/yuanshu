// Built UI, real AudioContext/worklet, Chromium synthetic mic and intercepted network.
// No physical microphone, live chat mutations or paid provider traffic.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '../..')
const dist = path.resolve(root, process.env.YUANSHU_VOICE_DIST || 'tmp/verification-dist')
const sid = 'voice-fixture', now = new Date().toISOString()
function asset(url) {
  const p = decodeURIComponent(new URL(url).pathname)
  const file = path.resolve(dist, p === '/' ? 'index.html' : p.slice(1))
  return file.startsWith(dist + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null
}
const mime = file => ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'
const serve = (req, res) => {
  const file = asset(new URL(req.url, 'http://localhost').href)
  if (!file) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'Permissions-Policy': 'microphone=(self)', 'Content-Type': mime(file) })
  fs.createReadStream(file).pipe(res)
}
const server = http.createServer(serve)
// Public test-only self-signed fixtures; never installed in a trust store.
const tlsServer = https.createServer({ key: fs.readFileSync(path.join(root, 'tests/fixtures/voice-local-key.pem')),
  cert: fs.readFileSync(path.join(root, 'tests/fixtures/voice-local-cert.pem')) }, serve)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
await new Promise(resolve => tlsServer.listen(0, '127.0.0.1', resolve))
const local = `http://127.0.0.1:${server.address().port}`
const secure = `https://127.0.0.1:${tlsServer.address().port}`
const until = async check => { const end = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < end, 'condition timeout'); await new Promise(r => setTimeout(r, 20)) } }
let browser
try {
  browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  for (const [width, base] of [[1440, local], [390, local], [390, secure]]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390, permissions: ['microphone'] })
    const page = await context.newPage(), errors = [], events = [], sockets = []
    let ticketRequests = 0, closedSockets = 0
    page.on('pageerror', e => errors.push(e.message))
    await context.routeWebSocket('**/*', ws => {
      if (new URL(ws.url()).pathname !== '/ws/chat-voice') return ws.close()
      assert.equal(new URL(ws.url()).search, '')
      assert.equal(new URL(ws.url()).host, new URL(base).host)
      sockets.push(ws); let first = true
      ws.onClose(() => { closedSockets++ })
      ws.onMessage(raw => {
        const event = JSON.parse(raw); events.push(event)
        if (first) {
          assert.deepEqual(event, { type: 'auth', ticket: 'fixture-ticket' }); first = false
          ws.send(JSON.stringify({ type: 'ready', conversationId: sid, sampleRate: 24000 }))
        }
      })
    })
    await context.route('**/*', route => {
      const u = new URL(route.request().url())
      if (u.origin !== base) return route.abort()
      const json = value => route.fulfill({ json: value })
      if (u.pathname === '/api/voice/ticket') {
        ticketRequests++; assert.equal(route.request().method(), 'POST')
        assert.equal(route.request().headers().authorization, 'Bearer fixture-only')
        assert.deepEqual(route.request().postDataJSON(), { conversationId: sid }); assert.equal(u.search, '')
        return json({ ticket: 'fixture-ticket', expiresIn: 60 })
      }
      if (u.pathname === '/api/sessions') return json({ sessions: [{ id: sid, name: '通话隔离验收', updatedAt: now }] })
      if (u.pathname.endsWith('/messages')) return json({ messages: [
        { id: 'u1', role: 'user', text: '检查实时通话', ts: now }, { id: 'a1', role: 'assistant', text: '这里是原有聊天。', ts: now },
      ], truncated: false })
      if (u.pathname === '/api/tts/capabilities') return json({ available: true, model: 'fixture' })
      if (u.pathname.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {"lastSeq":0}\n\n' })
      if (u.pathname === '/api/run/overview') return json({ active: [], recent: [] })
      if (u.pathname.startsWith('/api/')) return json({})
      return route.continue()
    })
    await page.addInitScript(({ sid }) => {
      localStorage.setItem('yuanshu_access_token', 'fixture-only'); localStorage.setItem('pi_last_session', sid)
      window.__call = { requested: 0, streams: [], played: 0, denied: false }
      const media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async options => {
        window.__call.requested++
        if (window.__call.denied) throw new DOMException('denied', 'NotAllowedError')
        const stream = await media(options); window.__call.streams.push(stream); return stream
      }
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function(...args) { window.__call.played++; return start.apply(this, args) }
      Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [{ lang: 'zh-CN' }], cancel() {}, pause() {}, resume() {}, speak(u) { u.onstart?.() } } })
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
    }, { sid })
    await page.goto(base + '/#/chat', { waitUntil: 'networkidle' })
    const read = page.getByRole('button', { name: '朗读回复', exact: true, includeHidden: true })
    await read.waitFor({ timeout: 20000 })
    const panel = page.getByRole('region', { name: '实时通话', exact: true })
    const entry = page.getByRole('button', { name: '语音通话', exact: true })
    await entry.click()
    const start = panel.getByRole('button', { name: /^(开始|再次)通话$/ })
    assert.equal(await start.isEnabled(), false); assert.equal(ticketRequests, 0)
    assert.equal(await page.evaluate(() => window.__call.requested), 0)
    assert.equal(await page.getByText('实时语音 · 本机试用', { exact: true }).count(), 0)
    await panel.getByRole('checkbox').check()
    await panel.getByRole('button', { name: '返回聊天', exact: true }).click()
    await page.getByRole('button', { name: '语音输入', exact: true }).click()
    await page.getByRole('button', { name: '取消录音', exact: true }).waitFor()
    assert.equal(await entry.isEnabled(), false)
    await page.getByRole('button', { name: '取消录音', exact: true }).click()
    const auto = page.getByRole('switch', { name: '自动朗读新回复', includeHidden: true })
    const openSound = async () => {
      await page.getByRole('button', { name: '查看情绪潮汐与真人形象' }).click()
      await page.getByRole('tab', { name: '声音', exact: true }).click()
    }
    await openSound(); await auto.click()
    await page.getByRole('button', { name: '关闭形象面板' }).click()
    await read.click(); await entry.click(); await start.click()
    await panel.getByText('已连接，可以说话', { exact: true }).waitFor()
    await until(() => events.some(e => e.type === 'audio'))
    assert.equal(await auto.count(), 0, 'closed settings are not interactive during a call')
    assert.equal(await read.isEnabled(), false)
    assert.equal(await page.getByRole('button', { name: '语音输入', exact: true, includeHidden: true }).isEnabled(), false)
    assert.equal(await page.getByRole('combobox', { name: '朗读通道', includeHidden: true }).count(), 0)
    const socket = sockets.at(-1)
    socket.send(JSON.stringify({ type: 'transcript', role: 'assistant', responseId: 'r1', text: '这是模拟通话转写。' }))
    socket.send(JSON.stringify({ type: 'audio', responseId: 'r1', itemId: 'i1', data: Buffer.alloc(48000).toString('base64') }))
    await panel.getByRole('button', { name: '转写', exact: true }).click()
    await panel.getByLabel('本次通话转写').getByText('这是模拟通话转写。', { exact: false }).waitFor()
    await page.waitForFunction(() => window.__call.played > 0)
    await panel.getByRole('button', { name: '静音', exact: true }).click()
    await page.waitForFunction(() => window.__call.streams.at(-1).getTracks().every(t => !t.enabled))
    await until(() => events.some(e => e.type === 'mute'))
    await panel.getByRole('button', { name: '取消静音', exact: true }).click()
    await panel.getByRole('button', { name: '打断回复', exact: true }).click()
    await until(() => events.some(e => e.type === 'interrupt'))
    const hangup = panel.getByRole('button', { name: '挂断', exact: true })
    const box = await hangup.boundingBox(); assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await hangup.click()
    await page.waitForFunction(() => window.__call.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')))
    await until(() => closedSockets === sockets.length)
    await panel.getByRole('button', { name: '返回聊天', exact: true }).click()
    await openSound()
    assert.equal(await auto.getAttribute('aria-checked'), 'false'); assert.equal(await auto.isEnabled(), true)
    await page.getByRole('button', { name: '关闭形象面板' }).click()
    await entry.click()
    for (const event of ['yuanshu-auth-change', 'pagehide', 'visibilitychange']) {
      await start.click(); await panel.getByText('已连接，可以说话', { exact: true }).waitFor()
      await page.evaluate(name => {
        if (name === 'visibilitychange') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event(name)) }
        else window.dispatchEvent(new Event(name))
      }, event)
      await start.waitFor()
      await page.waitForFunction(() => window.__call.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')))
      await until(() => closedSockets === sockets.length)
    }
    const before = ticketRequests
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); window.__call.denied = true })
    await start.click(); await panel.getByText(/未获得麦克风权限/).waitFor()
    assert.equal(ticketRequests, before); assert.deepEqual(errors, [])
    console.log(JSON.stringify({ width, simulatedOrigin: base === local ? 'loopback' : 'HTTPS', passed: true, realWorklet: true, physicalMic: false, providerCalls: 0, ticketRequests }))
    await context.close()
  }
} finally {
  await browser?.close()
  for (const listener of [server, tlsServer]) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)) }
}
