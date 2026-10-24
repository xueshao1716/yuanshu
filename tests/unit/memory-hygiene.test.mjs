import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractFacts, probeEntry, planGrowth, applyGrowth, runHygieneDaily } from '../../engine/memory-hygiene.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-'))

test('写入自检：数字/日期/名字丢了要报出来', () => {
  const src = '2026-10-24 用 deepseek-flash 跑完，耗时 4100ms，改了 app/dist/engine 三个文件'
  const good = '2026-10-24 用 deepseek-flash 更了 app/dist/engine'
  const bad = '今天更新了一下引擎'
  const g = probeEntry({ sourceText: src, memoryText: good })
  const b = probeEntry({ sourceText: src, memoryText: bad })
  assert.ok(g.score > b.score, '保留事实的分数应更高')
  assert.ok(b.missing.includes('4100'), '丢了 4100 应被指出')
  assert.ok(b.missing.length > 0)
})

test('事实抽取：至少拿到日期与数字', () => {
  const facts = extractFacts('2026-10-24 花了 30 元，改了 server.mjs')
  assert.ok(facts.some((f) => f.includes('2026-10-24')))
  assert.ok(facts.some((f) => f === '30'))
  assert.ok(facts.some((f) => f.includes('server.mjs')))
})

test('增长惩罚：超条目就归档老条目，主文件只留近期，另存备份', () => {
  const ws = tmp()
  const rel = '工程/经验库/experience.md'
  const file = path.join(ws, ...rel.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const entries = Array.from({ length: 12 }, (_, i) => `### 2026-10-${String(i + 1).padStart(2, '0')} 条目 ${i}\n内容 ${i}`)
  fs.writeFileSync(file, '# 经验库\n\n' + entries.join('\n\n') + '\n', 'utf8')
  const limits = { [rel]: { maxBytes: 10 * 1024 * 1024, keepEntries: 5 } }
  const plan = planGrowth(ws, limits)
  assert.equal(plan[0].action, 'trim')
  assert.equal(plan[0].archiveEntries, 7)
  const applied = applyGrowth(ws, limits)
  assert.equal(applied[0].action, 'archived')
  const main = fs.readFileSync(file, 'utf8')
  assert.match(main, /条目 11/, '最新的要留下')
  assert.doesNotMatch(main, /条目 0\b/, '最老的应被移出主文件')
  const archive = fs.readFileSync(`${file}.archive.md`, 'utf8')
  assert.match(archive, /条目 0\b/, '归档文件里还有')
  assert.ok(fs.readdirSync(path.dirname(file)).some((n) => n.includes('.bak-')), '应有备份')
})

test('记忆卫生：一天只跑一次', () => {
  const ws = tmp()
  const first = runHygieneDaily(ws, new Date('2026-10-24T03:10:00'))
  assert.equal(first.skipped, false)
  const second = runHygieneDaily(ws, new Date('2026-10-24T09:10:00'))
  assert.equal(second.skipped, true)
})
