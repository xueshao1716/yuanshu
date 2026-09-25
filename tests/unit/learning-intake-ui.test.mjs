import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const read = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
test('knowledge library displays experience and intake with honest loading/error/qualification labels', () => {
  const apps = read('frontend/src/pages/Apps.tsx')
  assert.ok(apps.includes('<LearningIntakePanel'))
  const panel = read('frontend/src/components/LearningIntakePanel.tsx')
  for (const token of ['experience', 'entries', '待提炼', '不等于已验证', 'isLoading', 'role="alert"', 'collection', 'failed', 'mutate']) assert.ok(panel.includes(token), token)
})
test('activity uses explicit active count, dates and persistent source instead of historical status inference', () => {
  const source = read('frontend/src/components/ActivityFeed.tsx')
  for (const token of ['activeCount', 'toLocaleString', '执行账本', '每 5 秒']) assert.ok(source.includes(token), token)
  assert.ok(!source.includes('const status = inferStatus(events)'))
})
test('server wires ordinary completion, local reconciliation and a single retry-safe collector', () => {
  const server = read('server.mjs')
  for (const token of ['onRunFinished: run => learningIntake.enqueue(run)', 'await learningIntake.reconcile()', 'await dreamCollector.collect()', '/api/learning-intake/status', 'buildPersistentActivity(runStore.list()']) assert.ok(server.includes(token), token)
  assert.ok(!server.includes('__dreamCursor'))
  assert.ok(!server.includes('skillEpisodesFromSessions(files)'))
})
