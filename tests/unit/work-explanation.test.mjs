import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkExplanation } from '../../engine/work-explanation.mjs'

const run = { id: 'r1', sessionId: 's1', status: 'completed', input: { messagePreview: '生成宣传视频', model: 'auto/auto' } }
const event = (type, data = {}, seq = 1) => ({ type, data, seq, ts: '2026-09-12T10:00:00Z' })

test('角色协作显示当前阶段和实际模型，已有主模型时不被子模型覆盖', () => {
  const role = event('subagent_started', { id: 'c1', agent: 'ANALYST', model: 'p/role-model' })
  const active = { ...run, status: 'running' }
  const out = buildWorkExplanation(active, [role])
  assert.equal(out.executor.model, 'p/role-model')
  assert.match(out.status.detail, /ANALYST/)
  assert.equal(buildWorkExplanation(active, [event('model_used', { model: 'p/main' }), role]).executor.model, 'p/main')
  assert.equal(buildWorkExplanation(active, [event('model_selected', { model: 'p/main' }), role]).executor.model, 'p/role-model')
  const ended = buildWorkExplanation(active, [role, event('subagent_finished', { id: 'c1', agent: 'ANALYST', status: 'failed', model: 'p/role-model' }, 2)])
  assert.match(ended.status.detail, /失败/)
})

test('结束、自报、真实检查通过和失败各自表达，不把回答当验收', () => {
  assert.equal(buildWorkExplanation(run).verification.state, 'not_observed')
  assert.equal(buildWorkExplanation(run, [event('verification', { verified: true, passed: true })]).verification.state, 'reported')
  assert.equal(buildWorkExplanation(run, [event('verification', { passed: true, source: 'runtime' })]).verification.state, 'passed')
  const out = buildWorkExplanation(run, [event('verification', { passed: false, producer: 'runtime' }), event('verification', { passed: true, producer: 'runtime' }, 2)])
  assert.equal(out.verification.state, 'failed')
  assert.match(out.nextStep, /检查/)
  assert.equal(out.status.label, '本轮已结束')
})

test('工具与子任务按 ID 合并，保留状态、结论及证据', () => {
  const out = buildWorkExplanation(run, [
    event('tool', { id: 't1', name: 'bash', args: { command: 'private command' } }),
    event('tool_end', { id: 't1', name: 'bash', output: 'private output' }, 2),
    event('subagent_started', { runId: 'child', role: 'analyst', task: '核查素材', status: 'running' }, 3),
    event('subagent_finished', { runId: 'child', status: 'completed', result: '已核实来源', evidence: ['资料页'], confidence: 0.8 }, 4),
  ])
  assert.equal(out.tools.count, 1)
  assert.equal(out.tools.items[0].status, 'completed')
  assert.equal(out.subagents.count, 1)
  assert.equal(out.subagents.items[0].task, '核查素材')
  assert.equal(out.subagents.items[0].summary, '已核实来源')
  assert.deepEqual(out.subagents.items[0].evidence, ['资料页'])
  assert.doesNotMatch(JSON.stringify(out), /private command|private output/)
})

test('仅接受同一轮的 AIBody 和子任务，补足承接和协作记录', () => {
  const bodyRun = { runId: 'r1', sessionId: 's1', mode: 'builder', continuity: { inheritedFrom: 'r0' }, events: [] }
  const child = { runId: 'c1', parentRunId: 'r1', sessionId: 's1', role: 'reviewer', task: '检查', result: '无问题', status: 'completed' }
  const out = buildWorkExplanation(run, [], { bodyRun, subagents: [child, { ...child, runId: 'c2', sessionId: 'other' }] })
  assert.match(out.basis.join(' '), /承接/)
  assert.equal(out.subagents.count, 1)
  assert.equal(buildWorkExplanation(run, [], { bodyRun: { ...bodyRun, runId: 'other' } }).basis.join(' ').includes('承接'), false)
})

test('显性层不包含隐含推理、凭证、原始参数和输出，列表有界', () => {
  const events = [event('think', { text: 'hidden thought' }), event('checkpoint', { historySnapshot: { text: 'private history' } })]
  for (let i = 0; i < 75; i++) events.push(event('tool_end', { id: `t${i}`, name: 'read', output: 'private output' }, i + 2))
  events.push(event('note', { text: 'token=secretvalue https://host/file?signature=secreturl' }, 80))
  const out = buildWorkExplanation({ ...run, error: 'Bearer sensitive.token token=secretvalue', status: 'failed' }, events)
  assert.doesNotMatch(JSON.stringify(out), /hidden thought|private history|private output|sensitive.token|secretvalue|secreturl/)
  assert.equal(out.tools.count, 75)
  assert.ok(out.tools.items.length <= 12)
})

test('记忆只计写入，文件只显示已记录，不伪造交付和真实验证', () => {
  const out = buildWorkExplanation(run, [event('memory_written', { count: 2, preview: '偏好短视频' }), event('media', { type: 'video', url: 'https://host/a.mp4?token=secret' })])
  assert.equal(out.memory.writes, 2)
  assert.equal(out.artifacts.count, 1)
  assert.equal(out.verification.state, 'not_observed')
  assert.doesNotMatch(JSON.stringify(out), /token=secret/)
})

test('终态优先于末尾事件；重启有可恢复建议；无记录明确表达', () => {
  const out = buildWorkExplanation({ ...run, status: 'interrupted', resumeAvailable: true, error: 'server_restarted' }, [event('tool', { id: 't1', name: 'read' })])
  assert.equal(out.status.label, '运行已中断')
  assert.match(out.nextStep, /继续任务/)
  assert.match(out.problem, /重启/)
  assert.equal(out.tools.items[0].status, 'not_observed')
  assert.match(buildWorkExplanation(run).executor.model, /未记录/)
})

test('有执行模型时区分实际模型和请求选择，记录真实引擎原因', () => {
  const out = buildWorkExplanation(run, [event('engine_selected', { engine: 'yuanshu', reason: '从已保存步骤恢复' }), event('done', { model: { provider: 'p', id: 'm' } })])
  assert.equal(out.executor.model, 'p/m')
  assert.equal(out.executor.engine, '元枢自建引擎')
  assert.match(out.basis.join(' '), /从已保存步骤恢复/)
})

test('工作说明把媒体模型列为旁路模型，不覆盖文本执行模型', () => {
  const out = buildWorkExplanation({ ...run, input: { messagePreview: '生成图片并做成网页' } }, [
    event('engine_selected', { engine: 'yuanshu' }),
    event('model_selected', { model: { provider: 'p', id: 'text-model' } }),
    event('media', { type: 'image', model: 'agnes/image-model', url: '/api/media/1' }),
    event('done', { model: { provider: 'p', id: 'text-model' } }),
  ])
  assert.equal(out.executor.model, 'p/text-model')
  assert.deepEqual(out.executor.mediaModels, ['agnes/image-model'])
})

test('文件代理地址保留文件身份，多个不同产物不会合并为一个接口地址', () => {
  const out = buildWorkExplanation(run, [
    event('media', { url: 'http://localhost/api/ws/file?path=videos%2Fa.mp4&token=secret' }),
    event('media', { url: 'http://localhost/api/ws/file?path=videos%2Fb.mp4&token=secret' }, 2),
  ])
  assert.equal(out.artifacts.count, 2)
  assert.equal(out.artifacts.items[0].path, 'videos/a.mp4')
  assert.doesNotMatch(JSON.stringify(out), /secret/)
})

test('旧版明确的引擎提示也能解释执行者，重复提示折叠，长工具 ID 不混淆', () => {
  const note = event('note', { text: '本轮主引擎 · 元枢（该通道走自制循环）' })
  const out = buildWorkExplanation(run, [note, note,
    event('tool', { id: 'a'.repeat(32), name: 'read' }),
    event('tool', { id: 'b'.repeat(32), name: 'read' }),
  ])
  assert.equal(out.executor.engine, '元枢自建引擎')
  assert.equal(out.notes.length, 1)
  assert.equal(out.tools.count, 2)
})
