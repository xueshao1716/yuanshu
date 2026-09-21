import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const module = await import('../../engine/aibody-runtime.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw error
})
function fixture(t, options = {}) {
  assert.equal(typeof module.createAIBodyRuntime, 'function', 'AIBody runtime factory must exist')
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-aibody-runtime-'))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  let tick = 0
  const settings = { rootDir, now: () => new Date(Date.UTC(2026, 8, 12) + tick++ * 1000).toISOString(), ...options }
  return { rootDir, settings, runtime: module.createAIBodyRuntime(settings) }
}
const input = (overrides = {}) => ({ runId: 'r1', sessionId: 's1', engine: 'yuanshu', source: 'chat', message: '做一个定西洋芋宣传PPT', ...overrides })

test('explicit resume reopens interrupted turn without erasing evidence or duplicating run', t => {
  const { runtime } = fixture(t)
  runtime.beginTurn(input())
  runtime.observe('r1', 'subagent', { id: 'first', agent: 'VIDEO' })
  runtime.finishTurn('r1', { status: 'interrupted' })
  assert.equal(runtime.beginTurn(input()).status, 'interrupted')
  assert.equal(runtime.beginTurn(input({ resume: true })).status, 'running')
  runtime.observe('r1', 'subagent', { id: 'second', agent: 'CRITIC' })
  assert.equal(runtime.getRun('r1').evidence.subagents, 2)
  assert.equal(runtime.overview().totals.runs, 1)
  runtime.finishTurn('r1')
  assert.equal(runtime.beginTurn(input({ resume: true })).status, 'completed')
})

test('empty runtime reports no observations or invented provider values', t => {
  const { runtime } = fixture(t)
  const view = runtime.overview()
  assert.equal(view.version, 1)
  assert.equal(view.currentRun, null)
  assert.deepEqual(view.engines, [])
  assert.equal(view.totals.runs, 0)
  assert.ok(view.roles.every(role => role.presence === 'not_observed'))
  assert.ok(Object.values(view.state).every(state => state.status === 'not_observed'))
})

test('overview makes companionship and evolution governance explicit without claiming consciousness', t => {
  const { runtime } = fixture(t)
  const view = runtime.overview()
  assert.deepEqual(view.companionship, {
    continuity: '同一会话承接已记录主题与状态',
    memory: '记忆可查看、可纠正、可由用户控制',
    boundary: '不模拟情感依赖，不替用户做价值判断',
  })
  assert.deepEqual(view.evolution, {
    mode: '提案制迭代（设计约束，非验收结果）',
    status: 'policy_only',
    humanApproval: null,
    rollback: null,
    scope: ['技能', '经验', '记忆', '工作方式'],
    protected: ['人格', '身份', '高风险权限'],
  })
})

test('beginTurn makes a builder directive with execution, evidence and authority boundaries', t => {
  const { runtime } = fixture(t)
  const run = runtime.beginTurn(input())
  assert.equal(run.runId, 'r1')
  assert.equal(run.mode, 'builder')
  assert.equal(run.status, 'running')
  assert.equal(run.phase, 'planning')
  for (const text of ['规划', '执行', '证据', '报告', '原有人格', '授权边界', '子分析员', '简单任务', '自动批准']) assert.ok(run.directive.includes(text), text)
  assert.equal(run.evidence.verifications, 0)
  assert.equal(runtime.overview({ sessionId: 's1' }).engines[0].id, 'yuanshu')
  assert.equal(runtime.beginTurn(input()).startedAt, run.startedAt)
  assert.throws(() => runtime.beginTurn(input({ sessionId: 's2' })), /runId/)
})

test('modes distinguish implementation, judgment, answer and conversation', t => {
  const { runtime } = fixture(t)
  for (const [mode, message] of [['builder', '继续做代码和架构'], ['analysis', '你怎么看这个取舍'], ['answer', '这个问题要怎么解释'], ['conversation', '今天有点累']]) {
    const run = runtime.beginTurn(input({ runId: mode, sessionId: mode, message }))
    assert.equal(run.mode, mode)
  }
  assert.match(runtime.beginTurn(input({ runId: 'analysis-only', message: '先分析问题，不要修改代码' })).directive, /先判断/)
})

test('continuation inherits the same session topic and treats previous result as unverified reference', t => {
  const { runtime } = fixture(t)
  runtime.beginTurn(input())
  runtime.finishTurn('r1', { status: 'failed', summary: 'PPT已生成的说法尚未核查', error: 'connection_lost' })
  const continued = runtime.beginTurn(input({ runId: 'r2', message: '好，你继续' }))
  assert.equal(continued.mode, 'builder')
  assert.equal(continued.topic, '做一个定西洋芋宣传PPT')
  assert.equal(continued.continuity.inheritedFrom, 'r1')
  assert.match(continued.directive, /PPT已生成的说法尚未核查/)
  assert.match(continued.directive, /未核实|未验证/)
  const other = runtime.beginTurn(input({ runId: 'other', sessionId: 's2', message: '继续' }))
  assert.equal(other.mode, 'conversation')
  assert.doesNotMatch(other.directive, /定西洋芋|PPT已生成的说法/)
  assert.equal(runtime.overview({ sessionId: 's2', runId: 'r1' }).currentRun, null)
})

test('public work evidence drives stages and records limited subagent authority', t => {
  const { runtime } = fixture(t)
  runtime.beginTurn(input())
  assert.equal(runtime.observe('r1', 'tool', { id: 't1', name: 'bash', status: 'running' }).phase, 'executing')
  runtime.observe('r1', 'tool', { id: 't1', name: 'bash', status: 'completed', summary: '构建完成' })
  runtime.observe('r1', 'subagent', { id: 'a1', role: 'analyst', status: 'completed', summary: '核查了产地资料' })
  runtime.observe('r1', 'memory_written', { path: '记忆/事实.md', summary: '记录已验证的产地事实' })
  runtime.observe('r1', 'artifact_created', { path: '交付/deck.pptx', name: 'deck.pptx' })
  assert.equal(runtime.observe('r1', 'verification', { passed: true, producer: 'model' }), null)
  const checking = runtime.observe('r1', 'verification', { id: 'check1', name: '检查PPT页数', passed: true, producer: 'runtime', summary: '10页可读取' })
  assert.equal(checking.phase, 'checking')
  assert.deepEqual(checking.evidence, { tools: 1, subagents: 1, memoryWrites: 1, artifacts: 1, verifications: 1 })
  const role = runtime.overview().roles.find(role => role.id === 'analyst')
  assert.equal(role.presence, 'observed')
  assert.match(role.authority, /不能.*批准|有限/)
  assert.equal(runtime.observe('missing', 'tool', {}), null)
  assert.equal(runtime.observe('r1', 'automatic_approval', { approved: true }), null)
})

test('successful responses are not automatically verified or grown', t => {
  const { runtime } = fixture(t)
  runtime.beginTurn(input())
  const run = runtime.finishTurn('r1', { status: 'completed', summary: '我已经做好了' })
  assert.equal(run.status, 'completed')
  assert.equal(run.evidence.verifications, 0)
  assert.equal(run.verified, undefined)
  assert.equal(run.growth, undefined)
  assert.equal(runtime.observe('r1', 'verification', { passed: true }), null)
  assert.equal(runtime.finishTurn('r1', { status: 'failed' }).status, 'completed')
})

test('failure and cancellation remain terminal and preserve real errors', t => {
  const { runtime } = fixture(t)
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    runtime.beginTurn(input({ runId: status }))
    const run = runtime.finishTurn(status, { status, error: '工具执行失败' })
    assert.equal(run.status, status)
    assert.equal(run.phase, status)
    assert.equal(run.error, '工具执行失败')
    assert.ok(run.finishedAt)
  }
})

test('restart restores durable continuity and interrupts unfinished runs', t => {
  const { settings, runtime } = fixture(t)
  runtime.beginTurn(input())
  runtime.observe('r1', 'artifact_created', { path: '交付/草稿.pptx' })
  const restarted = module.createAIBodyRuntime(settings)
  assert.equal(restarted.overview().continuity.restored, true)
  assert.equal(restarted.overview().continuity.recoveredRuns, 1)
  assert.equal(restarted.overview().currentRun.status, 'interrupted')
  assert.equal(restarted.overview().currentRun.evidence.artifacts, 1)
  const continued = restarted.beginTurn(input({ runId: 'r2', message: '继续' }))
  assert.equal(continued.mode, 'builder')
  assert.equal(continued.continuity.inheritedFrom, 'r1')
})

test('provider summaries influence the directive without changing their data or approving proposals', t => {
  const state = { identity: { summary: '林心语，保留既有人格' }, genes: { summary: '来自现有基因表达', details: { caution: 0.7 } }, memory: { summary: '会话相关记忆已检索' }, governance: { summary: '有一条提案待主用户审查', details: { pending: 1, approved: 0 } } }
  const original = JSON.stringify(state)
  const { runtime } = fixture(t, { readState: () => state })
  const run = runtime.beginTurn(input())
  assert.match(run.directive, /会话相关记忆已检索/)
  runtime.finishTurn('r1', { status: 'completed' })
  assert.equal(JSON.stringify(state), original)
  assert.equal(runtime.overview().state.governance.details.approved, 0)
  assert.equal(runtime.overview().state.genes.details.caution, 0.7)
})

test('provider failures are visible and never stop work', t => {
  const { runtime } = fixture(t, { readState: () => { throw new Error('token=should-not-leak') } })
  assert.equal(runtime.beginTurn(input()).status, 'running')
  assert.ok(Object.values(runtime.overview().state).every(state => state.status === 'unavailable'))
  assert.doesNotMatch(JSON.stringify(runtime.overview()), /should-not-leak/)
})

test('persisted turns and events are bounded and omit prompts, tool bodies and secrets', t => {
  const { runtime, rootDir } = fixture(t, { maxRuns: 3, maxEvents: 3 })
  for (let i = 0; i < 5; i++) {
    runtime.beginTurn(input({ runId: `r${i}`, message: '做一个PPT token=private-test-secret ' + '正文'.repeat(2000) }))
    for (let j = 0; j < 6; j++) runtime.observe(`r${i}`, 'tool', { id: `t${j}`, name: 'bash', summary: 'password=not-for-storage', args: 'PRIVATE_TOOL_ARGS', output: 'PRIVATE_TOOL_OUTPUT' })
    runtime.finishTurn(`r${i}`, { status: 'completed', summary: 'Bearer abcdefghijklmnopqrstuvwxyz' })
  }
  const view = runtime.overview()
  assert.equal(view.runs.length, 3)
  assert.ok(view.runs.every(run => run.events.length <= 3 && run.topic.length <= 180))
  const raw = fs.readFileSync(path.join(rootDir, 'aibody-runtime.json'), 'utf8')
  assert.doesNotMatch(raw, /private-test-secret|not-for-storage|PRIVATE_TOOL_ARGS|PRIVATE_TOOL_OUTPUT|abcdefghijklmnopqrstuvwxyz|directive/)
  assert.ok(raw.length < 15000)
})
