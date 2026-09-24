import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  canonicalStepKey,
  createRunEffects,
  hashArgs,
} from '../../engine/run-effects.mjs'
import { scheduleToolCalls } from '../../engine/tool-scheduler.mjs'

function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-run-effects-'))
  let tick = 0
  const now = () => `2026-09-09T10:00:0${tick++}.000Z`
  return { rootDir, now, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) }
}

test('corrupt ledger cannot be silently replaced by subsequent writes', () => {
  const { rootDir, cleanup } = fixture()
  try {
    const effects = createRunEffects({ rootDir })
    const file = path.join(rootDir, 'effects', 'broken.json')
    fs.writeFileSync(file, '{broken')
    for (const write of [() => effects.begin('broken', 'new'), () => effects.complete('broken', 'new', 'ok'), () => effects.markUncertain('broken', 'new')]) {
      assert.throws(write, /effects_ledger_invalid/)
      assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
    }
  } finally { cleanup() }
})

test('canonicalStepKey 对参数键顺序稳定，并区分同轮不同序号', () => {
  assert.equal(hashArgs({ b: 2, a: 1 }), hashArgs({ a: 1, b: 2 }))
  assert.equal(
    canonicalStepKey('write', { b: 2, a: 1 }, { turn: 3, index: 0 }),
    canonicalStepKey('write', { a: 1, b: 2 }, { turn: 3, index: 0 }),
  )
  assert.notEqual(
    canonicalStepKey('write', { a: 1 }, { turn: 3, index: 0 }),
    canonicalStepKey('write', { a: 1 }, { turn: 3, index: 1 }),
  )
})

test('effects ledger 持久化已完成步骤，重载后可复用结果且不重新执行', () => {
  const { rootDir, now, cleanup } = fixture()
  try {
    const first = createRunEffects({ rootDir, now })
    const key = canonicalStepKey('write', { path: 'a.txt', content: 'hello' }, { turn: 1, index: 0 })
    assert.equal(first.begin('run-1', key, { toolName: 'write', replayPolicy: 'state-checked' }).action, 'execute')
    first.complete('run-1', key, { text: '写入成功', isError: false })

    const reloaded = createRunEffects({ rootDir, now })
    const reused = reloaded.begin('run-1', key, { toolName: 'write' })
    assert.equal(reused.action, 'reuse')
    assert.deepEqual(reused.result, { text: '写入成功', isError: false })
    assert.equal(reloaded.list('run-1').length, 1)
  } finally { cleanup() }
})

test('执行中断的步骤被标为 uncertain，恢复时 fail-closed', () => {
  const { rootDir, now, cleanup } = fixture()
  try {
    const effects = createRunEffects({ rootDir, now })
    const key = canonicalStepKey('bash', { command: 'echo hi' }, { turn: 1, index: 0 })
    assert.equal(effects.begin('run-1', key, { toolName: 'bash', replayPolicy: 'never' }).action, 'execute')
    effects.markUncertain('run-1', key, 'process_crashed')
    const retry = effects.begin('run-1', key, { toolName: 'bash', replayPolicy: 'never' })
    assert.equal(retry.action, 'blocked')
    assert.equal(retry.reason, 'uncertain')
  } finally { cleanup() }
})

test('调度器恢复时复用已提交结果，不再次调用副作用工具', async () => {
  const { rootDir, now, cleanup } = fixture()
  try {
    const effects = createRunEffects({ rootDir, now })
    const args = { path: 'a.txt', content: 'hello' }
    const key = canonicalStepKey('write', args, { turn: 2, index: 0 })
    effects.begin('run-1', key, { toolName: 'write', turn: 2, ordinal: 0 })
    effects.complete('run-1', key, { text: 'cached', isError: false })
    let calls = 0
    const results = await scheduleToolCalls({
      toolCalls: [{ id: 'new-provider-id', function: { name: 'write', arguments: JSON.stringify(args) } }],
      tools: { execute: async () => { calls++; return { text: 'fresh' } } },
      effects,
      executionContext: { runId: 'run-1', attempt: 2, turn: 2 },
    })
    assert.equal(calls, 0)
    assert.equal(results[0].out.text, 'cached')
    assert.equal(results[0].out.reused, true)
  } finally { cleanup() }
})

test('调度器遇到未确定步骤时阻断重放并提示确认', async () => {
  const { rootDir, now, cleanup } = fixture()
  try {
    const effects = createRunEffects({ rootDir, now })
    const args = { command: 'echo hi' }
    const key = canonicalStepKey('bash', args, { turn: 1, index: 0 })
    effects.begin('run-1', key, { toolName: 'bash' })
    effects.markUncertain('run-1', key, 'process_crashed')
    let calls = 0
    const [result] = await scheduleToolCalls({
      toolCalls: [{ id: 'retry-id', function: { name: 'bash', arguments: JSON.stringify(args) } }],
      tools: { execute: async () => { calls++; return { text: 'must not run' } } },
      effects,
      executionContext: { runId: 'run-1', attempt: 2, turn: 1 },
    })
    assert.equal(calls, 0)
    assert.equal(result.out.uncertain, true)
    assert.match(result.out.text, /未自动重试|确认外部状态/)
  } finally { cleanup() }
})
