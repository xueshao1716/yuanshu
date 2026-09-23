// Isolated browser storage + read-only API replay. No model calls or session writes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright')

const base = process.env.YUANSHU_FRONTEND_URL || 'http://127.0.0.1:5192'
const backend = 'http://127.0.0.1:8787'
const token = fs.readFileSync(new URL('../../.token', import.meta.url), 'utf8').trim()
const headers = { Authorization: `Bearer ${token}` }
let sid = 'regression-message-reconciliation'
let parts = ['先检查回归样本。', '工具结果核对完毕。', '最终结论只应显示一次。']
let history = [
  { id: 'u1', role: 'user', text: '验证复杂消息流', ts: '2026-09-21T10:00:00Z' },
  ...parts.map((text, i) => ({ id: `s${i}`, role: 'assistant', text,
    tools: i < 2 ? [{ id: `call-${i}`, name: 'read', output: 'ok', isError: false }] : [],
    ts: `2026-09-21T10:0${i + 1}:00Z` })),
]
let text = parts.join('')
let tools = history.flatMap(m => m.tools || [])
if (process.env.YUANSHU_REPLAY_SESSION && process.env.YUANSHU_REPLAY_RUN) {
  sid = process.env.YUANSHU_REPLAY_SESSION
  const response = await fetch(`${backend}/api/sessions/${sid}/messages?tail=0`, { headers })
  assert.equal(response.status, 200)
  history = (await response.json()).messages
  const eventsResponse = await fetch(`${backend}/api/runs/${process.env.YUANSHU_REPLAY_RUN}/events`, { headers })
  assert.equal(eventsResponse.status, 200)
  const events = (await eventsResponse.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
  text = events.filter(e => e.type === 'delta').map(e => e.data.text || e.data.delta?.text || '').join('')
  tools = events.filter(e => e.type === 'tool').map(e => ({ ...e.data, running: false }))
  parts = history.slice(history.findLastIndex(m => m.role === 'user') + 1).map(m => m.text || '').filter(Boolean)
  assert.equal(parts.join(''), text, '真实事件与已保存的有序正文一致')
}
const local = { id: 'a-regression-snapshot', role: 'assistant', sessionId: sid,
  text, tools, engine: 'pi', ts: history.at(-1).ts, synced: true, draft: false }
const browser = await chromium.launch({ headless: true })
try {
  for (const mode of ['desktop-completed', 'mobile-completed', 'desktop-recovery']) {
    const active = mode.endsWith('recovery')
    const context = await browser.newContext({ viewport: mode.startsWith('mobile') ? { width: 390, height: 844 } : { width: 1440, height: 960 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url())
      const p = url.pathname
      const json = value => route.fulfill({ json: value })
      if (route.request().method() !== 'GET') return json({ error: 'read-only regression browser' })
      if (p === '/api/sessions') return json({ sessions: [{ id: sid, name: '消息流回归回放', updatedAt: local.ts }] })
      if (p === `/api/sessions/${sid}/messages`) return json({ messages: history, truncated: false })
      if (p === `/api/sessions/${sid}/stream`) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {"lastSeq":0}\n\n' })
      if (p === '/api/run/overview') return json({ active: [], recent: [] })
      if (p === '/api/runs/replay-run') return json({ id: 'replay-run', sessionId: sid, status: 'running', lastSeq: 11 })
      if (p === '/api/runs/replay-run/events') return route.fulfill({ contentType: 'text/event-stream', body:
        [10, 11].map(seq => `data: ${JSON.stringify({ runId: 'replay-run', seq, type: seq === 10 ? 'delta' : 'note', data: seq === 10 ? { text: 'REPLAY_MUST_NOT_APPEND' } : { text: '恢复检查' } })}\n\n`).join('') })
      return route.continue()
    })
    await page.addInitScript(({ token, sid, local, active }) => {
      localStorage.setItem('yuanshu_access_token', token)
      localStorage.setItem('pi_last_session', sid)
      if (active) localStorage.setItem(`pi_active_run:${sid}`, JSON.stringify({
        runId: 'replay-run', sessionId: sid, assistantMessageId: local.id, lastSeq: 10, status: 'running',
        stream: { text: local.text, think: '', thinkDone: true, conclusion: '', tools: local.tools,
          notes: [], files: [], images: [], audios: [], videos: [] },
      }))
      window.__seedReady = new Promise((resolve, reject) => {
        const request = indexedDB.open('pi_web_messages', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'id' }).createIndex('sessionId', 'sessionId')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction('messages', 'readwrite')
          tx.objectStore('messages').put({ ...local, draft: active, streaming: active })
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onerror = () => reject(tx.error)
        }
      })
    }, { token, sid, local, active })
    const check = async () => {
      await page.waitForFunction(marker => [...document.querySelectorAll('.chat-turn-list .markdown-body-wrapper')].some(el => el.textContent.includes(marker)), parts.at(-1).split('\n')[0].slice(0, 15))
      if (active) await page.getByText('恢复检查', { exact: true }).waitFor()
      const visibleText = (await page.locator('.chat-turn-list .markdown-body-wrapper').allTextContents()).join('\n')
      for (const part of parts) {
        // Opening plain-text line remains unchanged by Markdown rendering.
        const marker = part.split('\n')[0].slice(0, 15)
        assert.equal(visibleText.split(marker).length - 1, 1, `${mode}: 每段正文只显示一次`)
      }
      assert.ok(!visibleText.includes('REPLAY_MUST_NOT_APPEND'), '恢复游标之前的 delta 不得再追加')
    }
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => window.__seedReady)
    await check()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await check()
    // SWR's default focus throttle is 5s, longer than the 3s fetch dedupe.
    await page.waitForTimeout(5200)
    const refresh = page.waitForResponse(r => r.url().includes(`/api/sessions/${sid}/messages`))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await refresh
    await check()
    assert.deepEqual(pageErrors, [], '页面无未处理异常')
    console.log(JSON.stringify({ mode, segments: parts.length, reload: 'passed', focusRefresh: 'passed', duplicateCount: 0 }))
    await context.close()
  }
} finally { await browser.close() }
