import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createNotifier, execNotifyUser } from '../../engine/notifier.mjs'

const quiet = { warn() {} }
const fakeRes = () => { const out = []; return { out, writableEnded: false, writeHead() {}, write: (s) => out.push(s) } }

test('通知落盘，重启后能补读，序号不回退', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-')), 'n.json')
  return (async () => {
    const a = createNotifier({ file, log: quiet })
    await a.notify({ title: '视频已生成', body: 'a.mp4' })
    const b = createNotifier({ file, log: quiet })
    assert.equal(b.list(0).length, 1)
    assert.equal((await b.notify({ title: 't', body: 'b' })).seq, 2)
  })()
})

test('订阅：不带游标只收以后的，带游标补发错过的', async () => {
  const n = createNotifier({ log: quiet })
  await n.notify({ title: 'old', body: 'x' })
  const live = fakeRes(); const liveReq = new EventEmitter()
  n.subscribe(live, liveReq, undefined)
  assert.ok(!live.out.some((s) => s.includes('old')), '首次连接不重放历史')
  await n.notify({ title: 'new', body: 'y' })
  assert.ok(live.out.some((s) => s.startsWith('event: notify') && s.includes('new')))
  const back = fakeRes(); n.subscribe(back, new EventEmitter(), 0)
  assert.ok(back.out.some((s) => s.includes('old')), '带游标重连补发')
  assert.equal(n.clients, 2)
  liveReq.emit('close')
  assert.equal(n.clients, 1)
})

test('长对话 run 终态才通知；短问答、中断不打扰', async () => {
  const n = createNotifier({ log: quiet })
  const base = { sessionId: 's1', startedAt: '2026-10-14T10:00:00Z' }
  assert.equal(n.runFinished({ ...base, status: 'completed', completedAt: '2026-10-14T10:00:10Z' }), null)
  assert.equal(n.runFinished({ ...base, status: 'stopped', stoppedAt: '2026-10-14T10:09:00Z' }), null)
  const done = await n.runFinished({ ...base, status: 'completed', completedAt: '2026-10-14T10:05:00Z' })
  assert.equal(done.ok, true)
  const failed = await n.runFinished({ ...base, status: 'failed', failedAt: '2026-10-14T10:05:00Z', error: '模型输出连续截断' })
  const evs = n.list(0)
  assert.match(evs[0].title, /完成/); assert.equal(evs[0].key, 'run:s1')
  assert.match(evs[1].title, /失败/); assert.match(evs[1].body, /截断/)
  assert.equal(failed.ok, true)
})

test('微信：开了就发；没开或失败如实告诉智能体，不假装送达', async () => {
  const sent = []
  const ok = createNotifier({ log: quiet, wechat: { notifyOwner: async (t) => { sent.push(t) } } })
  assert.equal((await ok.notify({ title: 'T', body: 'B', toWechat: true })).wechat, 'sent')
  // 2026-10-24 起推送改成卡片排版（标题 + 分割线 + 要点 + 时间脚注），不再原样发 'T\nB'。
  assert.equal(sent.length, 1)
  assert.match(sent[0], /T/, '卡片里要有标题')
  assert.match(sent[0], /B/, '卡片里要有正文要点')
  assert.equal((await ok.notify({ title: 'T', body: 'B' })).wechat, 'skipped')
  const off = createNotifier({ log: quiet, wechat: { notifyOwner: async () => { throw new Error('没打开「通知发到微信」') } } })
  const r = await off.notify({ title: 'T', body: 'B', toWechat: true })
  assert.match(r.wechat, /^failed/)
  const tool = await execNotifyUser(off, { title: 'T', body: 'B' }, { sessionId: 's' })
  assert.match(tool.text, /微信没发出去/)
  assert.equal((await execNotifyUser(off, { title: '' }, {})).isError, true)
})

test('接线：server 注册 notify_user / 通知流 / run 与定时任务终态钩子；Capacitor 安卓壳带下载桥', () => {
  const server = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8')
  // 曾经写成 /NOTIFY_USER_TOOL,\s*\n?\s*\]/（等价于「必须是数组最后一个」），
  // 只要后面再追加任何工具就会误报——这里只断言它在列表里。
  assert.match(server, /^\s*NOTIFY_USER_TOOL,$/m, 'notify_user 必须进 UNIFIED_TOOLS')
  assert.match(server, /notify_user:\s*\(args, ctx\) => execNotifyUser/)
  assert.match(server, /\/api\/notify\/stream/)
  assert.match(server, /notifier\.runFinished\(run\)/)
  assert.match(server, /onTaskFinished/)
  const main = fs.readFileSync(new URL('../../android/app/src/main/java/com/pixinyu/app/MainActivity.java', import.meta.url), 'utf8')
  assert.match(main, /addJavascriptInterface\(downloads, "YuanshuDownloads"\)/, 'Capacitor 壳必须带系统保存窗口的下载桥')
})
