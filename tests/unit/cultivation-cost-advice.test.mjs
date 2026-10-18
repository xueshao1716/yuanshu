// 费用闸的人话建议（2026-10-18 伙伴："让她自己决定吧，人性化一点"）。
// 目标不是替她定数字，而是让她知道：这条能自己改、改到多少够、走哪个动作。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { costGateAdvice, REASON_HINT } from '../../engine/cultivation/delegate.mjs'

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

test('费用闸建议同时给出两个金额与最低需要的额度', () => {
  const text = costGateAdvice({ maxCostCents: 120, capCents: 50 })
  assert.match(text, /1\.20 美元/, '本次最坏费用')
  assert.match(text, /0\.50 美元/, '设计稿上限')
  assert.match(text, /至少 120（美分）/, '最低需要写到的额度')
})

test('建议里写明这是她自己能做的事，不用找主人', () => {
  const text = costGateAdvice({ maxCostCents: 120, capCents: 50 })
  assert.match(text, /不用找主人/)
  assert.match(text, /design\.submit/)
  assert.match(text, /母体可自行完成/)
  assert.match(text, /只能收窄/, '解释为什么修订不行、要走新设计稿')
})

test('缺失或非法数字时不产出半截建议', () => {
  assert.equal(costGateAdvice(null), '')
  assert.equal(costGateAdvice({}), '')
  assert.equal(costGateAdvice({ maxCostCents: 'x', capCents: 50 }), '')
})

test('终止原因提示同样指向自助路径', () => {
  assert.match(REASON_HINT.cultivation_cost_cap_exceeded, /自行重试/)
  assert.match(REASON_HINT.cultivation_cost_cap_exceeded, /不用找主人/)
})

test('预检话术给出每日预算与自助动作', () => {
  const src = read('../../engine/cultivation/policy-diagnostics.mjs')
  assert.match(src, /母体可自行完成/)
  assert.match(src, /dailyBudgetCents/)
  assert.match(src, /只能收窄/)
})

test('操作文档说明额度由她自己决定', () => {
  const doc = read('../../docs/cultivation-operations.md')
  assert.match(doc, /额度由谁决定/)
  assert.match(doc, /design\.submit/)
  assert.match(doc, /加工具、扩数据范围、递归/)
})
