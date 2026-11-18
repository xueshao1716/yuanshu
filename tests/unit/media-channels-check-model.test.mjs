// 2026-11-18：问"openrouter 通着没"她翻了 310 次工具、撞 27 次密钥墙——没有能用已存密钥测模型的工具。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMediaToolExecutor, MEDIA_TOOL_SCHEMAS, formatSensitiveHint } from '../../engine/media/channels.mjs'
import { detectStuck, recordStuckEvent } from '../../engine/yuanshu-stuck.mjs'

const models = [{ provider: 'openrouter', id: 'a/b' }, { provider: 'openrouter', id: 'c/d' }, { provider: 'deepseek', id: 'deepseek-flash' }]

test('check_model 用宿主探测，不碰密钥；默认测通道第一个', async () => {
  const seen = []
  const exec = createMediaToolExecutor({ getModelList: () => models, probeModel: async m => { seen.push(m); return m.provider === 'deepseek' ? { ok: false, error: 'HTTP 402' } : { ok: true } } })
  assert.ok(MEDIA_TOOL_SCHEMAS.some(s => s.function.name === 'check_model'))
  const ok = await exec('check_model', { provider: 'openrouter' })
  assert.match(ok.text, /✅ openrouter\/a\/b 通着/)
  const bad = await exec('check_model', { provider: 'deepseek' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /402/)
  const none = await exec('check_model', { provider: 'nope' })
  assert.match(none.text, /已配置：openrouter、deepseek/)
  assert.deepEqual(seen, [{ provider: 'openrouter', id: 'a/b' }, { provider: 'deepseek', id: 'deepseek-flash' }])
  assert.match(formatSensitiveHint({ channels: [] }), /check_model/)
})

test('换着路径反复撞密钥墙：3 次提醒，6 次中断', () => {
  const wall = i => recordStuckEvent('bash', { command: `cat path${i}/auth.json` }, { text: '凭据由宿主代持，对话通道不见明文。', isError: false })
  const ok = recordStuckEvent('bash', { command: 'ls' }, { text: 'x' })
  const events = [wall(1), ok, wall(2)]
  assert.equal(detectStuck(events), null)
  events.push(wall(3))
  assert.equal(detectStuck(events).soft, true)
  events.push(ok)
  assert.equal(detectStuck(events), null, '最近一次没撞墙就不打断')
  events.push(wall(4), wall(5), wall(6))
  const hard = detectStuck(events)
  assert.equal(hard.soft, false)
  assert.match(hard.hint, /check_model/)
})
