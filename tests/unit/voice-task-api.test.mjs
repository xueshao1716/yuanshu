import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { voiceRuntimeFixture } from '../helpers/voice-runtime-fixture.mjs'
import { createVoiceTaskRuntime } from '../../engine/voice-task-runtime.mjs'
import { createVoiceTaskApi } from '../../engine/voice-task-api.mjs'
import { json, readBody } from '../../engine/http-utils.mjs'

async function fixture(t) {
  const f = voiceRuntimeFixture(t, createVoiceTaskRuntime), runtime = f.make()
  const api = createVoiceTaskApi({ runtime, authorize: req => req.headers.authorization === 'Bearer isolated-test', readBody, json })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET') return api.list(res, req, url)
    if (url.pathname === '/stop') return api.stop(res, req, url.searchParams.get('taskId'))
    return api.submit(res, req)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const request = async (path, body, authenticated = true) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: authenticated ? { authorization: 'Bearer isolated-test' } : {}, body,
    })
    return { status: res.status, body: await res.json() }
  }
  return { ...f, runtime, request }
}
test('HTTP receipts replay, list and stop without creating duplicate executions', async t => {
  const f = await fixture(t), body = JSON.stringify({ conversationId: f.id, requestId: 'http-one', tasks: [{ title: '报告', instruction: '生成测试报告' }] })
  const [first, replay] = await Promise.all([f.request('/', body), f.request('/', body)])
  assert.equal(first.status, 202); assert.equal(replay.status, 202)
  assert.equal(first.body.group.id, replay.body.group.id)
  const conflict = await f.request('/', body.replace('生成测试报告', '修改后的任务'))
  assert.equal(conflict.status, 409)
  const listed = await f.request('/?conversationId=' + f.id)
  assert.equal(listed.status, 200); assert.equal(listed.body.tasks.length, 1)
  const stopped = await f.request('/stop?taskId=' + listed.body.tasks[0].id, JSON.stringify({ conversationId: f.id }))
  assert.equal(stopped.status, 200); assert.equal(stopped.body.task.status, 'stopped')
  await f.runtime.tick(); assert.equal(f.executions.length, 0)
})
test('HTTP malformed JSON is a client error, not a retryable task outage', async t => {
  const f = await fixture(t), res = await f.request('/', '{broken')
  assert.equal(res.status, 400); assert.equal(res.body.code, 'invalid_request')
  assert.equal(f.manager.list().length, 0)
})
test('HTTP oversized body returns 413 and never schedules work', async t => {
  const f = await fixture(t), res = await f.request('/', JSON.stringify({ text: 'x'.repeat(180000) }))
  assert.equal(res.status, 413); assert.equal(res.body.code, 'request_too_large')
  assert.equal(f.manager.list().length, 0)
})
test('HTTP authorization precedes parsing even for invalid bodies', async t => {
  const f = await fixture(t), res = await f.request('/', '{broken', false)
  assert.equal(res.status, 401); assert.equal(res.body.code, 'unauthorized')
  assert.equal(f.manager.list().length, 0)
})
test('unexpected runtime failures do not expose exception text or credentials', async () => {
  const api = createVoiceTaskApi({ runtime: { list: () => { throw new Error('Bearer private-upstream-secret') } },
    authorize: () => true, json: (res, status, body) => Object.assign(res, { status, body }) })
  const res = {}; await api.list(res, {}, new URL('http://localhost/?conversationId=origin'))
  assert.equal(res.status, 503); assert.equal(res.body.code, 'voice_task_unavailable')
  assert.ok(!JSON.stringify(res).includes('private-upstream-secret'))
})
