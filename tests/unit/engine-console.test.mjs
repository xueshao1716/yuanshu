import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const source = name => {
  const path = new URL(`../../frontend/src/${name}`, import.meta.url)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test('engine console distinguishes configuration and unavailable observations', () => {
  const src = source('pages/Engine.tsx')
  for (const text of ['当前模型选择', '配置主驾', '观测暂不可用', '加载中', 'EngineRunDiagnostics', 'Promise.allSettled', 'mutateRuns(RunApi.overview()', 'mutatePair(EngineApi.pair()']) {
    assert.ok(src.includes(text), `missing ${text}`)
  }
  assert.ok(!src.includes("health.status || 'idle'"), 'missing data must not mean healthy')
})

test('console status remains legible with wallpaper and code mode retains its mounted state', () => {
  const src = source('pages/Engine.tsx')
  assert.ok(src.includes('bg-pi-bg'))
  assert.ok(!src.includes('<HealthBadge'))
  assert.ok(src.includes('terminalMounted &&'))
  assert.ok(!src.includes('terminalOpen &&'))
  assert.ok(src.includes("terminalOpen ? 'flex"))
})

test('task inspector distinguishes historical failures from active work', () => {
  const src = source('components/TaskInspector.tsx')
  assert.match(src, /当前空闲 · 有历史异常/)
  assert.match(src, /health\?\.activeCount/)
})

test('diagnostics filter actual failed states and navigate to the matching session', () => {
  const src = source('components/engine/EngineRunDiagnostics.tsx')
  for (const text of ["run.status === 'failed'", "run.status === 'interrupted'", '最近', 'onOpenSession(run.sessionId)', '<details', '<summary', 'run.error', 'RunTimeline']) {
    assert.ok(src.includes(text), `missing ${text}`)
  }
  assert.ok(!src.includes('RunApi.get'), 'summary must not pretend raw run detail has normalized phase')
})

test('tools support accessible search and distinguish failed requests from empty results', () => {
  const src = source('components/engine/EngineTools.tsx')
  for (const text of ['type="search"', 'aria-label="搜索工具"', 'toLowerCase()', '没有匹配的工具', '工具列表暂不可用', 'aria-expanded']) assert.ok(src.includes(text), text)
})

test('pair and plugin writes report errors inline and prevent duplicate actions', () => {
  const pair = source('components/engine/EnginePairPanel.tsx')
  const gateway = source('components/engine/EngineGatewayPanels.tsx')
  for (const src of [pair, gateway]) {
    assert.ok(src.includes('role="alert"'))
    assert.ok(src.includes('disabled='))
    assert.ok(!src.includes('alert('))
  }
  assert.ok(pair.includes('EngineApi.savePair'))
  assert.ok(gateway.includes('registerPlugin'))
  assert.ok(gateway.includes('unregisterPlugin'))
})
