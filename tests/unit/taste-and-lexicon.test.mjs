import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recordTaste, listTaste, searchTaste, tastePromptText } from '../../engine/taste.mjs'
import { MOOD_33, labelForState, zhForCode } from '../../engine/mood-lexicon.mjs'

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'taste-'))

test('品味库：记录后可列可搜，缺字段拒绝', () => {
  const dir = ws()
  const a = recordTaste(dir, { topic: '封面字体', chose: '思源宋体', rejected: ['黑体', '书法体'], why: '正文要耐读', tags: ['设计'] })
  assert.equal(a.ok, true)
  recordTaste(dir, { topic: '压缩策略', chose: '先摘要再重链', why: '减少上下文' })
  assert.equal(recordTaste(dir, { topic: '缺 chose' }).ok, false)
  const list = listTaste(dir, 10)
  assert.equal(list.length, 2)
  assert.equal(list[0].topic, '压缩策略', '新的在前')
  assert.equal(searchTaste(dir, '宋体', 5).length, 1)
  assert.equal(searchTaste(dir, '不存在', 5).length, 0)
})

test('品味库：提示词片段只给判断，不含长篇', () => {
  const dir = ws()
  recordTaste(dir, { topic: '封面字体', chose: '思源宋体', rejected: ['黑体'], why: '正文要耐读' })
  const text = tastePromptText(dir, 5)
  assert.match(text, /品味库/)
  assert.match(text, /封面字体/)
  assert.match(text, /选「思源宋体」/)
  assert.match(text, /否：黑体/)
  assert.ok(text.length < 400)
})

test('心情词表：33 个词、分层齐全、坐标能映射回自己', () => {
  assert.equal(MOOD_33.length, 33)
  const layers = new Set(MOOD_33.map((m) => m.layer))
  assert.deepEqual([...layers].sort(), ['base', 'complex', 'modern'])
  // 每个词用自身坐标应映射回自己（最近邻自洽）
  for (const m of MOOD_33) {
    assert.equal(labelForState({ v: m.v, a: m.a, d: m.d }).code, m.code, `${m.zh} 应映射回自己`)
  }
  assert.equal(zhForCode('loving'), '恋慕')
  assert.equal(zhForCode('calm'), '平静')
})
