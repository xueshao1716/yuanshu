// engine/memory/gardener.mjs 单测（规则化记忆园丁：去重/过时状态/膨胀，只报告不自动写）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanMemoryHealth, gardenMemory } from '../../engine/memory/gardener.mjs'

function mk(wsRoot, { log = '', fixed = '' } = {}) {
  mkdirSync(join(wsRoot, '记忆'), { recursive: true })
  if (log) writeFileSync(join(wsRoot, '记忆', '记忆日志.md'), log, 'utf8')
  if (fixed) writeFileSync(join(wsRoot, '记忆.md'), fixed, 'utf8')
}

test('干净记忆 → 无重复/无过时/无建议', () => {
  const ws = mkdtempSync(join(tmpdir(), 'gardener-'))
  mk(ws, {
    log: '### 2026-08-25 10:00\n- 有项目/交付活动\n- 要点：做了某功能\n### 2026-08-26 09:00\n- 用户表达了偏好/约定\n- 要点：记住要用深色科技风\n',
    fixed: '## 当前状态（2026-08-26）\n- 今日正常\n',
  })
  const r = scanMemoryHealth(ws)
  assert.equal(r.error, undefined)
  assert.equal(r.duplicates.length, 0)
  assert.equal(r.staleSections.staleCount, 0)
  assert.equal(r.recommendations.length, 0)
  assert.equal(r.totalEntries, 2)
  rmSync(ws, { recursive: true, force: true })
})

test('重复/流水账条目 → 报 duplicates', () => {
  const ws = mkdtempSync(join(tmpdir(), 'gardener-'))
  mk(ws, {
    log: '### 2026-08-25 10:00\n- 有项目/交付活动\n- 要点：交付了页面 https://a\n### 2026-08-25 11:00\n- 有项目/交付活动\n- 要点：交付了页面 https://a\n### 2026-08-26 09:00\n- 用户偏好\n- 要点：深色科技风\n',
  })
  const r = scanMemoryHealth(ws)
  assert.equal(r.duplicates.length, 1, '应检测到 1 组重复')
  assert.equal(r.duplicates[0].count, 2)
  assert.ok(r.recommendations.some(x => x.includes('重复')))
  rmSync(ws, { recursive: true, force: true })
})

test('固定记忆过时「当前状态」节堆积 → 报 staleSections', () => {
  const ws = mkdtempSync(join(tmpdir(), 'gardener-'))
  mk(ws, {
    fixed: '## 当前状态（2026-08-01）\n- 旧状态\n## 当前状态（2026-08-26）\n- 新状态\n',
  })
  const r = scanMemoryHealth(ws)
  assert.equal(r.staleSections.total, 2)
  assert.ok(r.staleSections.staleCount >= 1, '应检测到过时的旧状态节')
  assert.ok(r.recommendations.some(x => x.includes('过时')))
  rmSync(ws, { recursive: true, force: true })
})

test('gardenMemory 只报告不写记忆（文件 mtime 不变）', () => {
  const ws = mkdtempSync(join(tmpdir(), 'gardener-'))
  const logPath = join(ws, '记忆', '记忆日志.md')
  mk(ws, { log: '### 2026-08-25 10:00\n- 有项目/交付活动\n- 要点：交付 X\n' })
  const m1 = statSync(logPath).mtimeMs
  const out = gardenMemory(ws)
  const m2 = statSync(logPath).mtimeMs
  assert.equal(out.ok, true)
  assert.equal(m1, m2, 'gardenMemory 不得改动记忆文件（只报告）')
  rmSync(ws, { recursive: true, force: true })
})
