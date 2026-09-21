import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { inferSkillCategory, inferSkillTags, classifySkillSource } from '../../engine/stats-api.mjs'

test('技能用途分类按显式分类优先，未标注时从名称和简介推导', () => {
  assert.equal(inferSkillCategory('my-tool', '用于生成演示文稿和 PPT'), 'presentation')
  assert.equal(inferSkillCategory('custom', '任意内容', 'video'), 'video')
  assert.equal(inferSkillCategory('unknown', '没有明显领域'), 'general')
})

test('技能标签保留显式标签并补充用途标签且去重', () => {
  const tags = inferSkillTags('poster-design', '生成海报与插画', ['品牌', '品牌'])
  assert.deepEqual(tags, ['品牌', '创作设计'])
})

test('技能来源区分仓库内自建和用户目录线上安装', () => {
  assert.equal(classifySkillSource(fileURLToPath(new URL('../../skills/demo/SKILL.md', import.meta.url)), 'package'), 'local')
  assert.equal(classifySkillSource('C:/Users/test/.agents/skills/demo/SKILL.md', 'user'), 'online')
  assert.equal(classifySkillSource('D:/pi-web/node_modules/@pi/skills/demo/SKILL.md', 'package'), 'online')
  assert.equal(classifySkillSource('', 'package'), 'builtin')
})
