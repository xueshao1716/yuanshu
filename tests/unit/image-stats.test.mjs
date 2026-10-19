// 画面统计 / 空镜检测（2026-10-19）
// 来源：Huashu-motion 自检清单；本机实证：今天 B 那张空黑图 stddev=1.64 被抓出，白球图 stddev=30.7 正常。
import test from 'node:test'
import assert from 'node:assert/strict'
import { statsFromGray, looksEmpty, EMPTY_STDDEV } from '../../engine/image-stats.mjs'

const uniform = (v, n = 1024) => Buffer.alloc(n, v)
const gradient = (n = 1024) => Buffer.from(Array.from({ length: n }, (_, i) => Math.round((i / n) * 255)))

test('纯色画面：标准差为 0、主色占比 1 → 判空镜', () => {
  const s = statsFromGray(uniform(0))
  assert.equal(s.stddev, 0)
  assert.equal(s.dominantShare, 1)
  assert.equal(looksEmpty(s), true)
})

test('正常画面：有层次就不算空镜（含今天实测过的两个数字）', () => {
  const s = statsFromGray(gradient())
  assert.ok(s.stddev > EMPTY_STDDEV)
  assert.equal(looksEmpty(s), false)
  // 真实产物的统计值：白球图 stddev≈30.7 / 空图 stddev≈1.64
  assert.equal(looksEmpty({ stddev: 30.69, dominantShare: 0.832, pixels: 1024 }), false)
  assert.equal(looksEmpty({ stddev: 1.64, dominantShare: 0.594, pixels: 1024 }), true)
})

test('单一像素值压倒性占比也判空镜（哪怕有一点噪点）', () => {
  const buf = Buffer.alloc(1024, 12)
  buf[0] = 200 // 一个亮点，标准差仍然很低
  assert.equal(looksEmpty(statsFromGray(buf)), true)
  const nearlyAll = Buffer.alloc(1024, 7)
  for (let i = 0; i < 8; i++) nearlyAll[i] = 250
  assert.equal(looksEmpty({ ...statsFromGray(nearlyAll), dominantShare: 0.99 }), true)
})

test('空输入返回 null，不抛', () => {
  assert.equal(statsFromGray(Buffer.alloc(0)), null)
  assert.equal(statsFromGray(null), null)
  assert.equal(looksEmpty(null), false)
})
