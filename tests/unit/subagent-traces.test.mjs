import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { initSubagent, spawnSubagent, getSubagentHistory } = await import('../../engine/subagent.mjs')
const { execDelegateTask } = await import('../../engine/yuanshu-delegate.mjs')

function model() { return { provider: 'fake', id: 'analysis-1' } }
function adapterResponse(body, { delay = 0 } = {}) {
  return async (_url, options = {}) => {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    if (options.signal?.aborted) return { status: 499, ok: false, text: async () => 'aborted', json: async () => ({}) }
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] }), text: async () => '' }
  }
}
async function setup(t, body = { result: '分析完成', evidence: ['D:/safe/file.md'], confidence: 0.8 }, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-subagent-trace-'))
  t.after(async () => fs.rm(dir, { recursive: true, force: true }))
  initSubagent({
    httpFetch: options.httpFetch || adapterResponse(body, options),
    authReader: () => ({ fake: { key: 'test-key' } }),
    modelReader: () => ({ fake: { models: [{ id: 'analysis-1', baseUrl: 'https://fake.invalid' }] } }),
    resolveAuth: () => ({ baseUrl: 'https://fake.invalid' }),
    getFlashModel: model,
    traceDir: dir,
  })
  return dir
}

test('records successful role execution with bounded context and correlation fields', async t => {
  const traceDir = await setup(t)
  const events = []
  const result = await spawnSubagent({ role: 'analyst', task: '判断方案', context: ['必要事实'], sessionId: 'session-1', runId: 'parent-1', onEvent: (type, data) => events.push({ type, data }), aibodyContext: { identity: '元枢', strategy: 'evidence-first', corrections: ['不要假完成'] } })
  assert.equal(result.done, true)
  assert.equal(result.subagentRunId != null, true)
  const rows = await getSubagentHistory({ sessionId: 'session-1', runId: 'parent-1', traceDir })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'analyst')
  assert.equal(rows[0].status, 'completed')
  assert.equal(rows[0].parentRunId, 'parent-1')
  assert.equal(rows[0].sessionId, 'session-1')
  assert.equal(rows[0].result, '分析完成')
  assert.deepEqual(events.map(e => e.type), ['subagent_started', 'subagent_finished'])
  assert.equal(JSON.stringify(rows).includes('必要事实'), false)
  assert.equal(JSON.stringify(rows).includes('不要假完成'), false)
  const files = await fs.readdir(traceDir)
  assert.equal(files.length, 1)
})

test('parent cancellation aborts before HTTP and closes trace as cancelled', async t => {
  let calls = 0
  const traceDir = await setup(t, undefined, { httpFetch: async () => { calls++; throw new Error('must not call') } })
  const controller = new AbortController(); controller.abort()
  const result = await spawnSubagent({ task: '不应执行', signal: controller.signal, sessionId: 's-cancel', runId: 'p-cancel' })
  assert.equal(calls, 0)
  assert.equal(result.done, false)
  assert.equal(result.cancelled, true)
  const rows = await getSubagentHistory({ sessionId: 's-cancel', runId: 'p-cancel', traceDir })
  assert.equal(rows[0].status, 'cancelled')
})

test('in-flight cancellation does not make another request and persists cancelled state', async t => {
  let calls = 0
  let requestStarted
  const started = new Promise(resolve => { requestStarted = resolve })
  const traceDir = await setup(t, undefined, { httpFetch: async (_url, options = {}) => {
    calls++
    requestStarted()
    await new Promise(resolve => {
      if (options.signal?.aborted) resolve()
      else options.signal.addEventListener('abort', resolve, { once: true })
    })
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  } })
  const controller = new AbortController()
  const promise = spawnSubagent({ task: '中途取消', signal: controller.signal, sessionId: 's-mid', runId: 'p-mid' })
  await started
  controller.abort()
  const result = await promise
  assert.equal(calls, 1)
  assert.equal(result.cancelled, true)
  const rows = await getSubagentHistory({ sessionId: 's-mid', runId: 'p-mid', traceDir })
  assert.equal(rows[0].status, 'cancelled')
})

test('timeout signal is combined with the parent and closes as a failed timeout', async t => {
  let calls = 0
  const traceDir = await setup(t, undefined, { httpFetch: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 60)); return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: '{"result":"too late"}' } }] }) } } })
  const result = await spawnSubagent({ task: '超时任务', timeoutMs: 10, sessionId: 's-timeout', runId: 'p-timeout' })
  assert.equal(calls, 1)
  assert.equal(result.done, false)
  assert.match(result.error, /超时/)
  const rows = await getSubagentHistory({ sessionId: 's-timeout', runId: 'p-timeout', traceDir })
  assert.equal(rows[0].status, 'failed')
  assert.match(rows[0].error, /超时/)
})

test('restarts recover orphan running records as interrupted and redact sensitive values', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-subagent-recover-'))
  t.after(async () => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, 'orphan.json'), JSON.stringify({ runId: 'orphan-run', role: 'reviewer', task: 'token=sk-abcdefghijklmnopqrstuvwxyz', status: 'running', model: 'fake/analysis-1', startedAt: new Date().toISOString(), evidence: ['Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz'] }))
  initSubagent({ traceDir: dir })
  const rows = await getSubagentHistory({ traceDir: dir })
  assert.equal(rows[0].status, 'interrupted')
  assert.equal(JSON.stringify(rows).includes('sk-abcdefghijklmnopqrstuvwxyz'), false)
  assert.equal(JSON.stringify(rows).includes('Authorization'), false)
})

test('delegate passes safe correlation context and keeps analysis-only result contract', async t => {
  const traceDir = await setup(t)
  const result = await execDelegateTask({ task: '核对结构', context: ['事实'] }, { sessionId: 'session-d', runId: 'parent-d', traceDir, role: 'reviewer', aibodyContext: { evidence: ['公开文件'] } })
  assert.equal(result.isError, false)
  assert.match(result.text, /子代理结论/)
  const rows = await getSubagentHistory({ sessionId: 'session-d', runId: 'parent-d', traceDir })
  assert.equal(rows[0].role, 'reviewer')
  assert.equal(rows[0].parentRunId, 'parent-d')
})
