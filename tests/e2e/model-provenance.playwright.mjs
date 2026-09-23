// Browser fixtures exercise stream replacement, persisted attribution and stale cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.YUANSHU_FRONTEND_URL || 'http://127.0.0.1:8787';
const token = fs.readFileSync(new URL('../../.token', import.meta.url), 'utf8').trim();
const requestedModel = { provider: 'stepfun-plan', id: 'step-5-preview' };
const model = { provider: 'test', id: 'actual-answer-model' };
const switchedModel = { ...model, reason: '验收用替换回复', sameModel: false };
const sid = 'model-provenance-browser-fixture';
const text = '验收最终结果只显示一次。';
const ts = new Date().toISOString();
const user = { id: 'u1', role: 'user', text: '检查回答来源', ts: new Date(Date.now() - 1000).toISOString() };
const saved = { id: 'a1', role: 'assistant', text, ts, model, requestedModel, switchedModel, engine: 'yuanshu' };
const browser = await chromium.launch({ headless: true });
try {
  for (const mode of ['desktop-saved', 'mobile-saved', 'desktop-replacement']) {
    const active = mode.endsWith('replacement');
    const context = await browser.newContext({ viewport: mode.startsWith('mobile') ? { width: 390, height: 844 } : { width: 1440, height: 960 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const json = value => route.fulfill({ json: value });
      if (route.request().method() !== 'GET') return json({ error: 'read-only browser fixture' });
      if (pathname === '/api/sessions') return json({ sessions: [{ id: sid, name: '模型归属验收', updatedAt: ts }] });
      if (pathname === `/api/sessions/${sid}/messages`) return json({ messages: [user, saved], truncated: false });
      if (pathname === `/api/sessions/${sid}/stream`) return route.fulfill({ contentType: 'text/event-stream', body: 'event: subscribed\ndata: {"lastSeq":0}\n\n' });
      if (pathname === '/api/run/overview') return json({ active: [], recent: [] });
      if (pathname === '/api/runs/provenance-run') return json({ id: 'provenance-run', sessionId: sid, status: 'running', lastSeq: 14 });
      if (pathname === '/api/runs/provenance-run/events') {
        const sequence = [
          ['response_replace', { text, think: '' }],
          ['model_switched', { ...switchedModel, requestedModel }],
          ['done', { sessionId: sid, model, requestedModel }],
          ['completed', { sessionId: sid }],
        ];
        return route.fulfill({ contentType: 'text/event-stream', body: sequence.map(([type, data], i) => `data: ${JSON.stringify({ runId: 'provenance-run', seq: i + 11, type, data })}\n\n`).join('') });
      }
      return route.continue();
    });
    await page.addInitScript(({ token, sid, user, saved, active }) => {
      localStorage.setItem('yuanshu_access_token', token);
      localStorage.setItem('pi_last_session', sid);
      const local = { ...saved, sessionId: sid, synced: true, model: saved.requestedModel, switchedModel: undefined, draft: active, streaming: active, text: active ? 'REJECTED_OLD_RESPONSE' : saved.text };
      if (active) localStorage.setItem(`pi_active_run:${sid}`, JSON.stringify({ runId: 'provenance-run', sessionId: sid, assistantMessageId: saved.id, lastSeq: 10, status: 'running', stream: { text: local.text, think: '', thinkDone: true, conclusion: '', tools: [], notes: [], files: [], images: [], audios: [], videos: [], requestedModel: saved.requestedModel } }));
      window.__seedReady = new Promise((resolve, reject) => {
        const request = indexedDB.open('pi_web_messages', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('messages', 'readwrite');
          tx.objectStore('messages').put({ ...user, sessionId: sid, synced: true });
          tx.objectStore('messages').put(local);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
    }, { token, sid, user, saved, active });
    for (let pass = 0; pass < 2; pass++) {
      if (pass) await page.reload({ waitUntil: 'domcontentloaded' });
      else await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => window.__seedReady);
      try { await page.getByText('实际 actual-answer-model', { exact: true }).waitFor(); }
      catch (error) { console.error(JSON.stringify({ mode, pass, errors, body: (await page.locator('body').innerText()).slice(-4500) })); throw error; }
      await page.getByText('所选 step-5-preview', { exact: true }).waitFor();
      await page.getByText('兜底 actual-answer-model', { exact: true }).waitFor();
      await page.waitForFunction(marker => [...document.querySelectorAll('.chat-turn-list .markdown-body-wrapper')].some(element => element.textContent.includes(marker)), text);
      const body = (await page.locator('.chat-turn-list .markdown-body-wrapper').allTextContents()).join('\n');
      assert.equal(body.split(text).length - 1, 1, `${mode}: replacement visible exactly once`);
      assert.ok(!body.includes('REJECTED_OLD_RESPONSE'));
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode, actualModel: model.id, requestedModel: requestedModel.id, reload: 'passed', response: 'unique' }));
    await context.close();
  }
} finally { await browser.close(); }
