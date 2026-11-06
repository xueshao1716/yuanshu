import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const source = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('各入口共享工作说明，聊天按会话取数并保留回看入口', () => {
  // 2026-09-14：改动验收并入工作台作为页内视图，其「近期工作说明」由工作台共享层统一渲染一次，
  // 因此它不再是第 4 个独立入口文件；改为断言工作台内确实嵌入了改动验收视图。
  for (const file of ['frontend/src/components/chat/ChatRunStatus.tsx', 'frontend/src/pages/Board.tsx', 'frontend/src/components/engine/EngineRunDiagnostics.tsx']) {
    assert.ok(source(file).includes('WorkExplanation'), file)
  }
  assert.ok(source('frontend/src/pages/Board.tsx').includes('ReviewPanel'), '改动验收视图必须并入工作台')
  const chat = source('frontend/src/components/chat/ChatRunStatus.tsx')
  assert.ok(chat.includes('RunApi.overview(sessionId'))
  assert.ok(!chat.includes('8000'))
  assert.ok(!chat.includes('lastRun'))
  const card = source('frontend/src/components/WorkExplanation.tsx')
  for (const token of ['verification', '尚无检查记录', '模型自报', '记忆写入', '<details', 'min-h-11', 'break-words']) assert.ok(card.includes(token), token)
  assert.ok(!source('frontend/src/components/RunContextSummary.tsx').includes('记忆命中'))
})

test('引擎选择产生结构化记录，真实模型随执行记录输出', () => {
  assert.ok(source('server.mjs').includes('sseWrite(res, "engine_selected"'))
  assert.ok(source('engine/unified-chat.mjs').includes('writer.push("model_selected"'))
  assert.ok(!source('engine/unified-chat.mjs').includes('{ model: chatModel }'))
  assert.ok(!source('server.mjs').includes('{ model: entry.agentModel || effModel }'))
})

test('页面模块加载失败说明恢复方式，重试重新加载而不是重复失败的 lazy 模块', () => {
  const boundary = source('frontend/src/hooks/useHashRoute.tsx')
  const reload = boundary.split('\n').find(line => line.includes('location.reload()')) || ''
  assert.ok(reload.includes('loadFailed'), '仅模块加载失败时重新加载页面')
  for (const text of ['Failed to fetch dynamically imported module', 'Loading chunk', 'Importing a module script failed', '重新加载页面', '错误详情']) assert.ok(boundary.includes(text), text)
  assert.ok(boundary.includes('min-h-11'))
})
