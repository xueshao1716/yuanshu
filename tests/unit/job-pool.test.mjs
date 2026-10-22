import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createJobPool } from '../../engine/job-pool.mjs'

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-')), 'jobs.json')

test('作业池：排队、限并发、完成', async () => {
  const pool = createJobPool({ file: tmpFile(), concurrency: 1 })
  const order = []
  const a = pool.submit({ kind: 't', title: 'A' }, async () => { order.push('A'); return 'a' })
  const b = pool.submit({ kind: 't', title: 'B' }, async () => { order.push('B'); return 'b' })
  assert.ok(['queued', 'running'].includes(a.status), '提交后应排队或在跑')
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(order, ['A', 'B'], '并发 1 时必须串行')
  const jobs = pool.list()
  assert.equal(jobs.length, 2)
  assert.ok(jobs.every((j) => j.status === 'done'))
  assert.equal(pool.get(b.id).resultPreview, 'b')
})

test('作业池：失败与取消都如实记录', async () => {
  const pool = createJobPool({ file: tmpFile(), concurrency: 2 })
  const bad = pool.submit({ kind: 't', title: '坏' }, async () => { throw new Error('boom') })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(pool.get(bad.id).status, 'failed')
  assert.match(pool.get(bad.id).error, /boom/)

  const long = pool.submit({ kind: 't', title: '长' }, (signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, 5000)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
  }))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(pool.get(long.id).status, 'running')
  assert.equal(pool.cancel(long.id).ok, true)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(pool.get(long.id).status, 'cancelled')
})

test('作业池：摘要反映在跑与排队', async () => {
  const pool = createJobPool({ file: tmpFile(), concurrency: 1 })
  pool.submit({ kind: 't', title: '一' }, () => new Promise((r) => setTimeout(() => r('ok'), 60)))
  pool.submit({ kind: 't', title: '二' }, async () => 'ok')
  const s = pool.summary()
  assert.equal(s.concurrency, 1)
  assert.equal(s.running + s.queued, 2)
})
