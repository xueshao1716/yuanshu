import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const read = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
test('knowledge library displays experience and intake with honest loading/error/qualification labels', () => {
  const apps = read('frontend/src/pages/Apps.tsx')
  assert.ok(apps.includes('<LearningIntakePanel'))
  const panel = read('frontend/src/components/LearningIntakePanel.tsx')
  for (const token of ['experience', 'entries', '<KnowledgePanel', '标题数量不是验证通过数', 'isLoading', 'role="alert"', 'collection', 'failed', 'mutate']) assert.ok(panel.includes(token), token)
  assert.ok(!panel.includes('candidates?.entries.map'), 'pending jobs have one knowledge control center')
})
test('activity uses explicit active count, dates and persistent source instead of historical status inference', () => {
  const source = read('frontend/src/components/ActivityFeed.tsx')
  for (const token of ['activeCount', 'toLocaleString', '执行账本', '每 5 秒']) assert.ok(source.includes(token), token)
  assert.ok(!source.includes('const status = inferStatus(events)'))
})
test('server wires ordinary completion, local reconciliation and a single retry-safe collector', () => {
  const server = read('server.mjs')
  // 2026-10-26：全文有多个 onRunFinished（培养那条在前），取第一个 slice 会切到别处。
  // 改成"含 notifier.runFinished 的那一段"，稳。
  const anchor = server.indexOf('notifier.runFinished(run)')
  assert.ok(anchor > 0, '找不到 runManager 的 onRunFinished 回调')
  const callback = server.slice(Math.max(0, anchor - 200), anchor + 400)
  for (const token of ['knowledgeRuntime.enqueueFinished(run)', 'learningIntake.enqueue(run)']) assert.ok(callback.includes(token), token)
  for (const token of ['await learningIntake.reconcile()', 'await dreamCollector.collect()', '/api/learning-intake/status', 'buildPersistentActivity(await runStore.listAsync()']) assert.ok(server.includes(token), token)
  assert.ok(!server.includes('__dreamCursor'))
  assert.ok(!server.includes('skillEpisodesFromSessions(files)'))
})
