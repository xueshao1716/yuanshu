// 长期目标：每天一轮洞察 + 可选方案（2026-11-23）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createLoopGoal, updateLoopGoal, parseInsights, addInsights, resolveInsight, executionPrompt,
  dueGoals, publicGoal, runLoopGoal, readLoopGoals, writeLoopGoals, buildInsightPrompt, MAX_ACTIVE,
} from '../../engine/goal-loop.mjs'

const SAMPLE = '好的：\n```json\n[{"problem":"文章更新太慢","evidence":"近两周只发了 1 篇","confidence":"high","options":[{"label":"列 10 个选题","detail":"按热度排"},{"label":"写一篇初稿"}]},{"problem":"只有一个方案","options":["做 A"]}]\n```'

test('createLoopGoal：标题必填，进行中最多 3 个', () => {
  assert.throws(() => createLoopGoal([], { title: '  ' }), /不能为空/)
  let goals = []
  for (let i = 0; i < MAX_ACTIVE; i++) goals = createLoopGoal(goals, { title: `目标${i}` })
  assert.throws(() => createLoopGoal(goals, { title: '再来一个' }), /最多/)
  goals = updateLoopGoal(goals, goals[0].id, { status: 'done' })
  assert.equal(createLoopGoal(goals, { title: '腾出位置了' }).length, MAX_ACTIVE + 1)
  assert.throws(() => updateLoopGoal(createLoopGoal(goals, { title: 'x' }), goals[0].id, { status: 'active' }), /最多/)
})

test('parseInsights：容忍代码块包裹，丢掉方案不足 2 个的', () => {
  const out = parseInsights(SAMPLE)
  assert.equal(out.length, 1)
  assert.equal(out[0].confidence, 'high')
  assert.deepEqual(out[0].options.map(o => o.id), ['o1', 'o2'])
  assert.equal(out[0].options[1].detail, '')
  assert.deepEqual(parseInsights('没有 JSON'), [])
  assert.deepEqual(parseInsights('[{坏的'), [])
})

test('addInsights：待处理超过上限时最旧的标成过期', () => {
  let g = createLoopGoal([], { title: 't' })[0]
  const one = parseInsights(SAMPLE)
  for (let i = 0; i < 8; i++) g = addInsights(g, one)
  assert.equal(g.insights.filter(i => i.status === 'pending').length, 6)
  assert.equal(g.insights.filter(i => i.status === 'expired').length, 2)
  assert.ok(g.lastRunAt)
})

test('resolveInsight：选方案记进展并给出执行提示；跳过不记；不能重复处理', () => {
  let goals = createLoopGoal([], { title: '做公众号' })
  goals = [addInsights(goals[0], parseInsights(SAMPLE))]
  const ins = goals[0].insights[0]
  assert.throws(() => resolveInsight(goals, goals[0].id, ins.id, { action: 'choose', optionId: 'o9' }), /方案不存在/)
  const r = resolveInsight(goals, goals[0].id, ins.id, { action: 'choose', optionId: 'o1' })
  assert.equal(r.insight.status, 'chosen')
  assert.equal(r.goal.log.length, 1)
  assert.match(r.goal.log[0].text, /列 10 个选题/)
  const prompt = executionPrompt(r.goal, r.insight, r.option, { workspace: 'D:\\ws', repo: 'D:\\code' })
  assert.match(prompt, /做公众号/)
  assert.match(prompt, /按热度排/)
  assert.match(prompt, /D:\\code/)
  assert.match(prompt, /绝对路径/)
  assert.throws(() => resolveInsight(r.goals, goals[0].id, ins.id, { action: 'skip' }), /处理过/)
  assert.deepEqual(publicGoal(r.goal).pending, [])
})

test('dueGoals：今天跑过的和暂停的不跑', () => {
  const now = new Date('2026-11-23T10:00:00')
  const goals = [
    { id: 'a', status: 'active', lastRunAt: '' },
    { id: 'b', status: 'active', lastRunAt: new Date('2026-11-23T08:00:00').toISOString() },
    { id: 'c', status: 'active', lastRunAt: new Date('2026-11-22T20:00:00').toISOString() },
    { id: 'd', status: 'paused', lastRunAt: '' },
  ]
  assert.deepEqual(dueGoals(goals, now).map(g => g.id), ['a', 'c'])
})

test('buildInsightPrompt：带上进展和跳过过的，别重复提', () => {
  let g = createLoopGoal([], { title: '减脂', detail: '每周三练' })[0]
  g = { ...addInsights(g, parseInsights(SAMPLE)), log: [{ at: '2026-11-20T00:00:00Z', text: '定了食谱' }] }
  g.insights[0].status = 'skipped'
  const p = buildInsightPrompt(g, { facts: '昨晚无事', today: '2026-11-23' })
  assert.match(p, /减脂/); assert.match(p, /每周三练/); assert.match(p, /定了食谱/); assert.match(p, /文章更新太慢/); assert.match(p, /昨晚无事/)
})

test('runLoopGoal：落盘洞察；模型没给可用结果时不动 lastRunAt', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-loop-'))
  try {
    writeLoopGoals(ws, createLoopGoal([], { title: '学吉他' }))
    const gid = readLoopGoals(ws)[0].id
    const bad = await runLoopGoal(ws, gid, { chat: async () => '想不出来' })
    assert.equal(bad.ok, false)
    assert.equal(readLoopGoals(ws)[0].lastRunAt, '')
    let seen = ''
    const ok = await runLoopGoal(ws, gid, { chat: async (p) => { seen = p; return SAMPLE }, facts: async () => '事实X' })
    assert.equal(ok.ok, true)
    assert.equal(ok.added, 1)
    assert.match(seen, /学吉他/); assert.match(seen, /事实X/)
    assert.equal(readLoopGoals(ws)[0].insights.length, 1)
    await assert.rejects(runLoopGoal(ws, 'nope', { chat: async () => SAMPLE }), /不存在/)
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})
