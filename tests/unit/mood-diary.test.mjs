import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectDay, composeDiary, writeDiary, listDiaries, readDiary } from '../../engine/mood-diary.mjs'

function world() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-'))
  fs.mkdirSync(path.join(ws, '记忆'), { recursive: true })
  const today = new Date().toLocaleDateString('sv-SE')
  const rows = [
    { ts: new Date().toISOString(), key: 's1', event: '今天把压缩修好了', felt: 'happy(70%)', intensity: 0.7 },
    { ts: new Date().toISOString(), key: 's2', event: '又是报错', felt: 'anxious(55%)', intensity: 0.55 },
    // 测试/探话不该进日记
    { ts: new Date().toISOString(), key: 's3', event: '只回复两个字：好的', felt: 'calm(51%)', intensity: 0.51 },
    { ts: new Date().toISOString(), key: 'eval-1', event: '真实事件但 eval', felt: 'calm(50%)', intensity: 0.5 },
  ]
  fs.writeFileSync(path.join(ws, '记忆', '情绪感受.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.writeFileSync(path.join(ws, '记忆', '情绪潮汐.jsonl'), [JSON.stringify({ ts: Date.now(), v: 0.6, a: 0.4, d: 0.5, w: 0.1, h: 0, c: 0, p: 'happy', i: 0.7, tags: [] })].join('\n') + '\n')
  return { ws, today }
}

test('心情日记：只收真实感受，测试事件被过滤', () => {
  const { ws, today } = world()
  const { feelings } = collectDay(ws, today)
  assert.equal(feelings.length, 2, `应只留 2 条真实感受，实际 ${feelings.length}`)
})

test('心情日记：正文包含次数/主色/起伏，且不出现测试语句', () => {
  const { ws, today } = world()
  const { feelings, tide } = collectDay(ws, today)
  const md = composeDiary({ date: today, feelings, tide })
  assert.match(md, /今天记下 2 次感受/)
  assert.match(md, /## 情绪的起伏/)
  assert.doesNotMatch(md, /只回复两个字/)
})

test('心情日记：写过就不重复写，force 才覆盖；无数据不硬造', () => {
  const { ws, today } = world()
  const first = writeDiary(ws, { date: today })
  assert.equal(first.skipped, false)
  const again = writeDiary(ws, { date: today })
  assert.equal(again.skipped, true)
  assert.equal(again.reason, 'exists')
  const forced = writeDiary(ws, { date: today, force: true })
  assert.equal(forced.skipped, false)
  const empty = writeDiary(ws, { date: '2000-01-01' })
  assert.equal(empty.skipped, true)
  assert.equal(empty.reason, 'no_data')
})

test('心情日记：列表与单篇可读', () => {
  const { ws, today } = world()
  writeDiary(ws, { date: today })
  const items = listDiaries(ws, 5)
  assert.equal(items.length, 1)
  assert.equal(items[0].date, today)
  assert.match(items[0].summary, /今天记下/)
  assert.match(readDiary(ws, today).text, /# /)
})
