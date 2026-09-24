import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRunApi } from '../../engine/run-api.mjs'
import { summarizeRun } from '../../engine/run-observability.mjs'
import { continuationLimits } from '../../engine/task-continuation.mjs'

const source = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const run = { id: 'r', sessionId: 's', status: 'queued', backgroundRecovery: { enabled: true, used: 1, maxResumes: 3, state: 'scheduled', scope: 'private-directory' } }

test('overview exposes recovery limits but not the workspace scope', () => {
  const summary = summarizeRun(run, [{ type: 'recovery_scheduled' }])
  assert.equal(summary.backgroundRecovery.used, 1)
  assert.equal(summary.phase, 'queued')
  assert.equal(JSON.stringify(summary).includes('private-directory'), false)
})

test('disable API is separate from stop and redacts internal workspace scope', async () => {
  let disabled = 0
  const api = createRunApi({ manager: { disableRecovery: id => { assert.equal(id, 'r'); disabled++; return run } }, json: (_res, status, body) => ({ status, body }) })
  const result = await api.disableRecovery({}, 'r')
  assert.equal(disabled, 1)
  assert.equal(result.status, 200)
  assert.equal(JSON.stringify(result.body).includes('private-directory'), false)
})

test('run deadline survives replacement model calls and is not reset by another invocation', () => {
  const deadline = Date.now() + 8000
  assert.equal(continuationLimits({ executionDeadlineAt: deadline }, 60).deadline, deadline)
  assert.ok(continuationLimits({ executionDeadlineAt: Date.now() - 1 }, 60).deadline <= Date.now())
})

test('server binds recovery scope and waits for listening before recovering tasks', () => {
  const server = source('server.mjs')
  assert.ok(server.includes('workspaceScope: () => CONFIG.cwd'))
  assert.ok(server.includes('/recovery/disable'))
  assert.ok(server.indexOf('runManager.recover()') > server.indexOf('server.listen(CONFIG.port'))
})

test('UI displays background policy and explicit disable without mislabelling it as stopping', () => {
  const view = source('frontend/src/components/ChatRunStatus.tsx')
  assert.ok(view.includes('BackgroundRecoveryStatus'))
  const component = source('frontend/src/components/BackgroundRecoveryStatus.tsx')
  assert.ok(component.includes('关闭自动接续'))
  assert.ok(component.includes('本轮继续执行'))
  assert.ok(component.includes('role="alert"'))
  assert.ok(source('frontend/src/components/ChatArea.tsx').includes("case 'recovery_scheduled':"))
})

test('both locked and normal engine paths inherit the execution deadline', () => {
  const text = source('engine/unified-chat.mjs')
  assert.ok(text.split('executionDeadlineAt: runContext?.executionDeadlineAt').length >= 3)
})

test('pro upgrade inherits deadline and completed history rather than replaying the task', () => {
  const line = source('engine/unified-chat.mjs').split('\n').find(line => line.includes('const proResult = await unifiedChat('))
  assert.ok(line.includes('executionDeadlineAt: runContext?.executionDeadlineAt'))
  assert.ok(line.includes('proModel, result.history || history'))
})
