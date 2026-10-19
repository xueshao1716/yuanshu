// 设计偏好回流（2026-10-19）：把返工记下来，下次生成前先用上。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { remember, loadPrefs, forget, learnFromReport, prefsBlock, designPrefsExecutors } from '../../engine/design-prefs.mjs'

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'))
const NOW = new Date('2026-10-19T16:00:00Z').getTime()

test('记录去重：同一条重复出现只加权重，不堆重复条目', () => {
  const root = ws()
  remember(root, { kind: 'avoid', text: '避免蓝紫色调', now: NOW })
  remember(root, { kind: 'avoid', text: '避免蓝紫色调', now: NOW })
  const items = loadPrefs(root).items
  assert.equal(items.length, 1)
  assert.equal(items[0].weight, 2)
})

test('偏好块：禁忌与正向取向分开写，权重高的在前，空库返回空串', () => {
  const root = ws()
  assert.equal(prefsBlock(root), '')
  remember(root, { kind: 'avoid', text: '文字被裁切', now: NOW })
  remember(root, { kind: 'prefer', text: '单一主体 + 大量负空间', now: NOW })
  remember(root, { kind: 'avoid', text: '背景过空', now: NOW })
  remember(root, { kind: 'avoid', text: '背景过空', now: NOW })
  const block = prefsBlock(root)
  assert.match(block, /避免（过往出过问题）：背景过空；文字被裁切/)
  assert.match(block, /可参考（过往通过的取向）：单一主体 \+ 大量负空间/)
  assert.equal(loadPrefs(root).items.find((i) => i.text === '背景过空').uses, 1, '用过要计数')
})

test('从报告学：巡检问题与失败记 avoid，干净通过且写清主体才记 prefer', () => {
  const root = ws()
  learnFromReport(root, { title: 'A', subject: '白球' }, {
    ok: false,
    issues: [{ level: 'error', code: 'ratio_mismatch', message: '比例不对：要求 2:1' }, { level: 'info', code: 'x', message: '可忽略' }],
    errors: [{ name: 'A', error: '产物拿不到（文件不存在）' }],
  }, { now: NOW })
  const items = loadPrefs(root).items
  assert.ok(items.some((i) => i.kind === 'avoid' && /比例不对/.test(i.text)))
  assert.ok(items.some((i) => i.kind === 'avoid' && /产物拿不到/.test(i.text)))
  assert.ok(!items.some((i) => /可忽略/.test(i.text)), 'info 级不该学')

  // 空图那次：通过但没有主体 → 不学
  learnFromReport(root, { title: 'B', subject: '' }, { ok: true, issues: [], errors: [] }, { now: NOW })
  assert.ok(!loadPrefs(root).items.some((i) => i.kind === 'prefer'))

  // 有主体且干净 → 学成 prefer
  learnFromReport(root, { title: 'C', subject: '一颗悬空的白色陶瓷球', goal: '纯黑背景，细线' }, { ok: true, issues: [], errors: [] }, { now: NOW })
  assert.ok(loadPrefs(root).items.some((i) => i.kind === 'prefer' && /白色陶瓷球/.test(i.text)))
})

test('删除与工具入口', async () => {
  const root = ws()
  const exec = designPrefsExecutors(root, { now: () => NOW }).design_prefs
  const added = await exec({ action: 'add', kind: 'avoid', text: '避免蓝紫色调' })
  assert.equal(added.isError, false)
  const listed = await exec({ action: 'list' })
  assert.match(listed.text, /避免蓝紫色调/)
  const id = loadPrefs(root).items[0].id
  assert.equal(forget(root, id).ok, true)
  assert.equal(loadPrefs(root).items.length, 0)
  const removed = await exec({ action: 'remove', id: 'nope' })
  assert.equal(removed.isError, true)
})

test('上限：条目不会无限增长', () => {
  const root = ws()
  for (let i = 0; i < 80; i++) remember(root, { kind: 'avoid', text: `条目 ${i}`, now: NOW })
  assert.ok(loadPrefs(root).items.length <= 60)
})
