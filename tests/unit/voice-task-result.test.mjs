import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRunStore } from '../../engine/run-store.mjs'
import { createRunEventLog } from '../../engine/run-event-log.mjs'
import { createTaskEvidence } from '../../engine/task-evidence.mjs'
import { readVoiceTaskResult, voiceTaskResultText } from '../../engine/voice-task-result.mjs'

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-voice-result-')), rootDir = path.join(cwd, 'runtime')
  const store = createRunStore({ rootDir }), log = createRunEventLog({ rootDir })
  t.after(() => { log.close(); fs.rmSync(cwd, { recursive: true, force: true }) })
  const run = store.create({ sessionId: 'worker', clientRequestId: 'task-one', message: '完成测试任务', model: 'fixture/text' })
  store.update(run.id, { status: 'completed' })
  const task = { id: 'task-one', sessionId: 'worker', conversationId: 'origin', runId: run.id, title: '报告', requirementRevision: 1 }
  const event = (type, data) => log.append({ runId: run.id, sessionId: run.sessionId, type, data })
  event('delta', { text: '测试任务的交付正文。' })
  const service = createTaskEvidence({ wsRoot: cwd, rootDir })
  return { cwd, store, run, task, event, service, read: () => readVoiceTaskResult(service, store.get(run.id), task) }
}
test('result rejects foreign run, session and request ownership', t => {
  const f = fixture(t), run = f.store.get(f.run.id)
  for (const change of [{ id: 'foreign' }, { sessionId: 'foreign' }, { clientRequestId: 'foreign' }])
    assert.throws(() => readVoiceTaskResult(f.service, { ...run, ...change }, f.task), { code: 'result_owner_mismatch' })
})
test('result rejects foreign evidence identity or mismatching terminal status', t => {
  const f = fixture(t), run = f.store.get(f.run.id), evidence = f.service.get(run.id)
  for (const change of [{ runId: 'foreign' }, { sessionId: 'foreign' }, { status: 'running' }])
    assert.throws(() => readVoiceTaskResult({ get: () => ({ ...evidence, ...change }) }, run, f.task), { code: 'result_owner_mismatch' })
})
test('result links only inspectable local artifacts and records failures', t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.cwd, '生成物')); fs.writeFileSync(path.join(f.cwd, '生成物/结果.json'), '{"ok":true}')
  for (const name of ['生成物/结果.json', '生成物/missing.json', '../outside.json', 'https://example.invalid/fake.json']) f.event('artifact_created', { path: name })
  const result = f.read()
  assert.equal(result.artifacts.length, 1); assert.equal(result.artifacts[0].path, '生成物/结果.json')
  assert.equal(result.artifacts[0].url, '/api/ws/file?path=' + encodeURIComponent('生成物/结果.json'))
  assert.match(result.verification, /结构检查：FAIL/); assert.equal(result.acceptance, 'pending')
  assert.ok(result.unfinished.some(item => item.includes('无法核对')))
})
test('structural failures remain visible even when a human accepted the task', t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.cwd, '生成物')); fs.writeFileSync(path.join(f.cwd, '生成物/broken.json'), '{broken')
  f.event('artifact_created', { path: '生成物/broken.json' })
  const current = f.service.get(f.run.id)
  f.service.review(f.run.id, { verdict: 'pass', digest: current.digest, revision: null, skills: [], note: '仅供回归测试' })
  const result = f.read(), text = voiceTaskResultText(f.task, result)
  assert.equal(result.status, 'completed'); assert.equal(result.acceptance, 'pass')
  assert.ok(text.includes('结构检查：FAIL')); assert.ok(text.includes('不代表内容质量验收'))
  assert.ok(result.unfinished.some(item => item.includes('未通过')))
})
test('summary is bounded and strips model-authored links before delivery', t => {
  const f = fixture(t)
  f.event('delta', { text: '[伪造下载](/api/ws/file?path=secrets) <script>x</script>' + '正文'.repeat(2000) })
  const result = f.read(), text = voiceTaskResultText(f.task, result)
  assert.ok(result.summary.length <= 1600)
  assert.ok(!text.includes('/api/ws/file?path=secrets')); assert.ok(!text.includes('<script>'))
  assert.equal(result.artifacts.length, 0)
  assert.ok(text.includes('/api/runs/' + f.run.id))
})
