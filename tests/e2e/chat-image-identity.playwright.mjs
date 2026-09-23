// Read-only replay in isolated browser storage; no model calls or production writes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { historyForRun } from '../helpers/replay-turn.mjs'
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.YUANSHU_FRONTEND_URL || 'http://127.0.0.1:8787'
const backend = 'http://127.0.0.1:8787'
const token = fs.readFileSync(new URL('../../.token', import.meta.url), 'utf8').trim()
const headers = { Authorization: `Bearer ${token}` }
const remote = 'https://images.example.com/generated/image.png'
const path = '生成物/图片/安睡图.png'
const url = '/api/ws/file?path=' + encodeURIComponent(path)
let sid = 'regression-image-identity'
let events = [
  { type: 'tool', data: { id: 'generate', name: 'generate_image', args: { prompt: '回归样本' } } },
  { type: 'tool_end', data: { id: 'generate', output: '已生成', isError: false } },
  { type: 'media', data: { type: 'image', url: remote } },
  { type: 'tool', data: { id: 'copy', name: 'bash', args: { command: `curl -sL -o "D:/pi-workspace/${path}" "${remote}"` } } },
  { type: 'tool_end', data: { id: 'copy', output: '下载完成', isError: false } },
  { type: 'media', data: { type: 'image', url } },
  { type: 'delta', data: { text: '图片已经保存。' } },
  { type: 'file', data: { path: `D:/pi-workspace/${path}` } },
]
let history = [
  { id: 'u1', role: 'user', text: '画图并保存', ts: '2026-09-21T13:00:00Z' },
  { id: 's1', role: 'assistant', text: '图片已经保存。', images: [remote], ts: '2026-09-21T13:01:00Z',
    tools: events.filter(e => e.type === 'tool').map(e => ({ ...e.data, output: '完成', isError: false })) },
  { id: 's2', role: 'assistant', text: '', files: [{ path: `D:/pi-workspace/${path}` }], ts: '2026-09-21T13:01:01Z' },
]
if (process.env.YUANSHU_REPLAY_SESSION && process.env.YUANSHU_REPLAY_RUN) {
  sid = process.env.YUANSHU_REPLAY_SESSION
  const response = await fetch(`${backend}/api/sessions/${sid}/messages?tail=0`, { headers })
  assert.equal(response.status, 200)
  history = (await response.json()).messages
  const replay = await fetch(`${backend}/api/runs/${process.env.YUANSHU_REPLAY_RUN}/events`, { headers })
  assert.equal(replay.status, 200)
  events = (await replay.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
  history = historyForRun(history, events)
}
const imageEvents = events.filter(e => e.type === 'media' && e.data.type === 'image')
assert.equal(imageEvents.length, 2, '回放包含在线图和本地副本')
const localUrl = imageEvents.find(e => e.data.url.startsWith('/api/ws/file')).data.url
const toolMap = new Map()
for (const e of events) {
  if (e.type === 'tool') toolMap.set(e.data.id, { ...e.data, argsText: JSON.stringify(e.data.args), running: true })
  if (e.type === 'tool_end') Object.assign(toolMap.get(e.data.id) || {}, e.data, { running: false })
}
const stream = {
  text: events.filter(e => e.type === 'delta').map(e => e.data.text || '').join(''),
  tools: [...toolMap.values()], images: imageEvents.map(e => e.data.url),
  files: events.filter(e => e.type === 'file').map(e => e.data),
  think: '', thinkDone: true, conclusion: '', notes: [], audios: [], videos: [],
}
const local = { ...stream, id: 'cached-image-snapshot', sessionId: sid, role: 'assistant',
  ts: history.at(-1).ts, synced: true, draft: false }
const browser = await chromium.launch({ headless: true })
try {
  for (const mode of ['desktop-cache', 'mobile-cache', 'mobile-live']) {
    const live = mode.endsWith('live')
    const context = await browser.newContext({ viewport: { width: mode.startsWith('mobile') ? 390 : 1440, height: 844 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.routeWebSocket('**/*', ws => ws.close())
    await page.route('**/*', async route => {
      const request = route.request()
      const pathname = new URL(request.url()).pathname
      const json = value => route.fulfill({ json: value })
      // Fixture pixels: verify layout and identity without fetching private/remote images.
      if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body:
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') })
      if (!pathname.startsWith('/api/')) return route.continue()
      if (request.method() !== 'GET') return json({ error: 'read-only regression browser' })
      if (pathname === '/api/sessions') return json({ sessions: [{ id: sid, name: '图片回归回放', updatedAt: local.ts }] })
      if (pathname === `/api/sessions/${sid}/messages`) return json({ messages: live ? history.slice(0, 1) : history, truncated: false })
      if (pathname === `/api/sessions/${sid}/stream`) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {"lastSeq":0}\n\n' })
      if (pathname === '/api/run/overview') return json({ active: [], recent: [] })
      if (pathname === '/api/runs/image-replay') return json({ id: 'image-replay', sessionId: sid, status: 'running', lastSeq: 3000 })
      if (pathname === '/api/runs/image-replay/events') {
        const replay = events.filter(e => ['tool', 'tool_end', 'media', 'file', 'delta'].includes(e.type))
        replay.push({ type: 'note', data: { text: '图片回放完成' } })
        return route.fulfill({ contentType: 'text/event-stream', body: replay.map((e, i) =>
          `data: ${JSON.stringify({ ...e, runId: 'image-replay', seq: i + 1 })}\n\n`).join('') })
      }
      return route.continue()
    })
    await page.addInitScript(({ token, sid, local, live }) => {
      localStorage.setItem('yuanshu_access_token', token)
      localStorage.setItem('pi_last_session', sid)
      if (live) localStorage.setItem(`pi_active_run:${sid}`, JSON.stringify({ runId: 'image-replay', sessionId: sid,
        assistantMessageId: local.id, lastSeq: 0, status: 'running', stream: {
          text: '', think: '', thinkDone: false, conclusion: '', tools: [], images: [], files: [], notes: [], audios: [], videos: [],
        } }))
      const request = indexedDB.open('pi_web_messages', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'id' }).createIndex('sessionId', 'sessionId')
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('messages', 'readwrite')
        if (!live) tx.objectStore('messages').put(local)
        tx.oncomplete = () => db.close()
      }
    }, { token, sid, local, live })
    const check = async () => {
      if (live) await page.getByText('图片回放完成', { exact: true }).waitFor()
      const imgs = page.locator('.chat-turn-list button[aria-label^="查看大图"] img')
      await imgs.first().waitFor()
      await page.waitForFunction(() => document.querySelector('.chat-turn-list .markdown-body-wrapper'))
      assert.equal(await imgs.count(), 1, `${mode}: 同一张图只能显示一次`)
      const src = await imgs.first().getAttribute('src')
      assert.equal(new URL(src, base).searchParams.get('path'), new URL(localUrl, base).searchParams.get('path'), '使用本地图片')
    }
    await page.goto(base, { waitUntil: 'networkidle' })
    await check()
    if (!live) { await page.reload({ waitUntil: 'networkidle' }); await check() }
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ mode, images: 1, localPreview: true, sourceEvents: events.length }))
    await context.close()
  }
} finally { await browser.close() }
