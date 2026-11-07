// run 记录里的 title（2026-11-07）：新建 run 一定有名字；老记录没存过也不报错，
// 读接口（详情/概览）按同一套规则兜底推导，保证看门狗/界面都能说清「是哪件事」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import { createRunStore } from '../../engine/run-store.mjs'
import { createRunApi } from '../../engine/run-api.mjs'
import { createTimeEngine } from '../../engine/time-engine.mjs'

class FakeResponse extends EventEmitter {
  constructor() { super(); this.statusCode = 0; this.headers = {}; this.chunks = []; this.writableEnded = false }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value }
  writeHead(code, headers = {}) { this.statusCode = code; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value) }
  write(chunk) { this.chunks.push(String(chunk)); return true }
  end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; this.emit('finish') }
  text() { return this.chunks.join('') }
}

function fakeJson(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-run-title-'))
  let id = 0
  const store = createRunStore({ rootDir, idFactory: () => `run-${++id}`, now: () => '2026-11-07T22:31:00.000Z' })
  return { rootDir, store, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) }
}

test('新建 run 把 title 落到顶层字段，重载后仍在', () => {
  const { rootDir, store, cleanup } = fixture()
  try {
    const run = store.create({ sessionId: 's', clientRequestId: 'c', message: '请帮我修一下登录页的样式' })
    assert.equal(run.title, '修一下登录页的样式')

    const raw = JSON.parse(fs.readFileSync(path.join(rootDir, 'runs', `${run.id}.json`), 'utf8'))
    assert.equal(raw.title, '修一下登录页的样式')

    const reloaded = createRunStore({ rootDir })
    assert.equal(reloaded.get(run.id).title, '修一下登录页的样式')
  } finally { cleanup() }
})

test('显式 title 与派活任务文本都能进记录；任务文本会清掉命令噪声', () => {
  const { store, cleanup } = fixture()
  try {
    const explicit = store.create({ sessionId: 's1', clientRequestId: 'c1', title: '整理桌面截图', message: '随便写点什么' })
    assert.equal(explicit.title, '整理桌面截图')

    const dispatched = store.create({ sessionId: 's2', clientRequestId: 'c2', task: '```bash\ncd /d/pi-web && npm test\n```', message: '随便' })
    assert.equal(dispatched.title, 'npm test')
  } finally { cleanup() }
})

test('定时任务 label / 子代理 name 作为注入入口同样生效', () => {
  const { store, cleanup } = fixture()
  try {
    const timed = store.create({ sessionId: 's1', clientRequestId: 'c1', label: '每日复盘', message: '' })
    assert.equal(timed.title, '每日复盘')

    const agent = store.create({ sessionId: 's2', clientRequestId: 'c2', name: '盯 CI 失败', message: '' })
    assert.equal(agent.title, '盯 CI 失败')
  } finally { cleanup() }
})

test('来源会记下来，空消息时兜底标题能说「微信 · HH:mm」', () => {
  const { store, cleanup } = fixture()
  try {
    const run = store.create({ sessionId: 's', clientRequestId: 'c', message: '', surface: 'wechat' })
    assert.equal(run.surface, 'wechat')
    // 测试时钟固定为本地 22:31（now() 返回的是 UTC 字符串，兜底按本地时区显示）
    assert.match(run.title, /^微信 · \d{2}:\d{2}$/)
  } finally { cleanup() }
})

test('老记录没有 title：读取不报错，详情接口按消息预览兜底推导', async () => {
  const { rootDir, store, cleanup } = fixture()
  try {
    const run = store.create({ sessionId: 's', clientRequestId: 'c', message: '请帮我整理截图' })
    // 模拟升级前落盘的老记录：没有 title 字段
    const file = path.join(rootDir, 'runs', `${run.id}.json`)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete raw.title
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8')

    const legacy = createRunStore({ rootDir })
    assert.equal(legacy.get(run.id).title, undefined, '老记录本身仍没有 title 字段')

    const api = createRunApi({ manager: { get: id => legacy.get(id), readAfter: () => [] }, json: fakeJson })
    const res = new FakeResponse()
    await api.get(res, run.id)
    const body = JSON.parse(res.text())
    assert.equal(body.title, '整理截图')
    assert.equal(res.statusCode, 200)
  } finally { cleanup() }
})

test('定时任务的 label 会推导成任务名；派活显式传入的任务名优先', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-time-title-'))
  try {
    const engine = createTimeEngine(null, { file: path.join(dir, 'time-tasks.json') })
    const labelOnly = engine.register({ prompt: '复盘', label: '每日复盘' })
    assert.equal(engine.find(labelOnly.id).title, '每日复盘')

    const dispatched = engine.register({ prompt: '整理桌面', label: '路由派活·微信', title: '整理桌面截图' })
    assert.equal(engine.find(dispatched.id).title, '整理桌面截图')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('概览接口也返回 title（新记录用存下的名字）', async () => {
  const { store, cleanup } = fixture()
  try {
    const named = store.create({ sessionId: 's1', clientRequestId: 'c1', message: '请帮我修登录页' })
    const second = store.create({ sessionId: 's2', clientRequestId: 'c2', message: '整理桌面截图' })
    const api = createRunApi({
      manager: {
        listAsync: async () => [named, second],
        readAfterAsync: async () => [],
      },
      json: fakeJson,
    })
    const res = new FakeResponse()
    await api.overview(res)
    const body = JSON.parse(res.text())
    const titles = body.recent.map(run => run.title)
    assert.ok(titles.includes('修登录页'), JSON.stringify(titles))
    assert.ok(titles.includes('整理桌面截图'), JSON.stringify(titles))
  } finally { cleanup() }
})
