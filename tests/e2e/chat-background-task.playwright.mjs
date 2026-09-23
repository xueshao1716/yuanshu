// Isolated browser/API fixtures: no model calls, real session writes or stop requests.
import assert from 'node:assert/strict'
import fs from 'node:fs'
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.YUANSHU_FRONTEND_URL || 'http://127.0.0.1:8787'
const token = fs.readFileSync(new URL('../../.token', import.meta.url), 'utf8').trim()
const sid = 'background-task-regression'
const runId = 'background-task-run'
const marker = '后台任务断线期间完成，结果只显示一次。'
const browser = await chromium.launch({ headless: true })
try {
  for (const mode of ['desktop', 'mobile', 'manual-stop']) {
    const context = await browser.newContext({ viewport: mode === 'mobile'
      ? { width: 390, height: 844 } : { width: 1440, height: 960 } })
    const page = await context.newPage()
    const errors = []
    const writes = []
    const cursors = []
    let completed = false
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const p = url.pathname
      const json = value => route.fulfill({ json: value })
      if (request.method() !== 'GET') {
        writes.push(p)
        return json({ id: runId, status: 'stopped' })
      }
      if (p === '/api/sessions') return json({ sessions: [{ id: sid, name: '后台执行回归测试', updatedAt: new Date().toISOString() }] })
      if (p === `/api/sessions/${sid}/messages`) return json({ messages: completed
        ? [{ id: 'final-reply', role: 'assistant', text: marker, ts: new Date().toISOString() }] : [], truncated: false })
      if (p === `/api/sessions/${sid}/stream`) return route.fulfill({ contentType: 'text/event-stream', body: ': ping\n\n' })
      if (p === '/api/run/overview') return json({ active: [], recent: [] })
      if (p === `/api/runs/${runId}`) return json({ id: runId, sessionId: sid, status: completed ? 'completed' : 'running', lastSeq: completed ? 9 : 7 })
      if (p === `/api/runs/${runId}/events`) {
        cursors.push(Number(url.searchParams.get('after')))
        const events = completed ? [
          { seq: 7, type: 'delta', data: { text: '旧游标正文不得重复' } },
          { seq: 8, type: 'delta', data: { text: marker } },
          { seq: 9, type: 'completed', data: {} },
        ] : []
        return route.fulfill({ contentType: 'text/event-stream', body: events.length
          ? events.map(event => `data: ${JSON.stringify({ runId, ...event })}\n\n`).join('') : ': ping\n\n' })
      }
      return route.continue()
    })
    await page.addInitScript(({ token, sid, runId }) => {
      localStorage.setItem('yuanshu_access_token', token)
      localStorage.setItem('pi_last_session', sid)
      const key = `pi_active_run:${sid}`
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
        runId, sessionId: sid, assistantMessageId: 'final-reply', lastSeq: 7, status: 'running',
        stream: { text: '', think: '', thinkDone: false, conclusion: '', notes: [],
          tools: [], files: [], images: [], audios: [], videos: [] },
      }))
    }, { token, sid, runId })
    await page.clock.install()
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.locator('button[title="停止"]').waitFor()
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.clock.fastForward(11 * 60 * 1000)
    await page.getByText(/不会因息屏或断连自动停止/).waitFor()
    assert.deepEqual(writes, [], `${mode}: 超过十分钟无事件不能请求停止`)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    assert.equal(await page.getByText(/长时间无响应，正在停止/).count(), 0)
    if (mode === 'manual-stop') {
      const stopped = page.waitForResponse(r => r.url().endsWith(`/api/runs/${runId}/stop`))
      await page.locator('button[title="停止"]').click()
      await page.getByText('正在停止任务…', { exact: true }).waitFor()
      await page.waitForFunction(() => localStorage.getItem('pi_active_run:background-task-regression')?.includes('stopping'))
      // Wait for the explicit request, not merely the optimistic UI update.
      await stopped
      assert.deepEqual(writes, [`/api/runs/${runId}/stop`])
    } else {
      completed = true
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => !localStorage.getItem('pi_active_run:background-task-regression'))
      await page.locator('.chat-turn-list .markdown-body-wrapper').getByText(marker, { exact: true }).waitFor()
      const text = (await page.locator('.chat-turn-list .markdown-body-wrapper').allTextContents()).join('\n')
      assert.equal(text.split(marker).length - 1, 1, '完成结果只出现一次')
      assert.ok(!text.includes('旧游标正文不得重复'), '恢复后不重放已处理的 delta')
      assert.ok(cursors.every(cursor => cursor >= 7), '恢复订阅必须使用已保存的游标')
      assert.deepEqual(writes, [], '刷新恢复不能停止或重建任务')
    }
    assert.deepEqual(errors, [], '页面无未处理异常')
    console.log(JSON.stringify({ mode, elapsedMinutes: 11, automaticStopRequests: 0,
      recovery: mode === 'manual-stop' ? 'manual-stop-verified' : 'completed-once' }))
    await context.close()
  }
} finally { await browser.close() }
