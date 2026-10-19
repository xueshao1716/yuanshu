// 技能桥（2026-10-19）：把原本就有的海报方法论接进委托提示词。
import test from 'node:test'
import assert from 'node:assert/strict'
import { excerptSkill, skillHintFor, skillBlockFor } from '../../engine/design-skills.mjs'

const RAW = `技能 wanxiang-design 已加载（3.3KB）：

---
name: wanxiang-design
description: 万像平面设计提示词系统
---

# 万像设计

## 输出契约
1. 只输出提示词本身，禁止内部编号。
2. 不留占位符。

## 章节索引
- 网格
`

test('摘录剥掉包装行、frontmatter、标题与元数据', () => {
  const text = excerptSkill(RAW)
  assert.ok(!text.includes('已加载'), '包装行要剥掉')
  assert.ok(!text.includes('name:'), 'frontmatter 要剥掉')
  assert.ok(!text.includes('description:'), '元数据要剥掉')
  assert.ok(!/^#/m.test(text), '标题要剥掉')
  assert.match(text, /只输出提示词本身/)
  assert.match(text, /不留占位符/)
})

test('超长摘录按句末截断，不劈句子', () => {
  const long = '第一句话说明规则。'.repeat(200)
  const out = excerptSkill(long, 120)
  assert.ok(out.length <= 121)
  assert.ok(out.endsWith('。') || out.endsWith('…'))
})

test('匹配到技能才返回；没匹配/空查询返回 null', () => {
  const skills = [{ name: 'xiaoyu-poster-prompt', desc: '海报 出图 提示词 组合法' }, { name: 'other', desc: '无关' }]
  const activate = () => RAW
  const hit = skillHintFor({ subject: '极简海报', goal: '出图提示词' }, { skills, activate })
  assert.equal(hit?.name, 'xiaoyu-poster-prompt')
  assert.match(hit.excerpt, /只输出提示词本身/)
  assert.equal(skillHintFor({ subject: '', goal: '' }, { skills, activate }), null)
})

test('拼成提示词块：带技能名，没匹配就是空串', () => {
  const skills = [{ name: 'xiaoyu-poster-prompt', desc: '海报 出图 提示词 组合法' }]
  const block = skillBlockFor({ subject: '极简海报', goal: '出图 提示词', brief: { deliverables: ['主海报'] } }, { skills, activate: () => RAW })
  assert.match(block, /可沿用的既有方法（技能 xiaoyu-poster-prompt）/)
  assert.equal(skillBlockFor({ subject: '', goal: '', brief: {} }, { skills, activate: () => RAW }), '')
})
