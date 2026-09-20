import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
// engine 是 ESM，直接 import
const { detectMediaIntents } = await import(new URL('../../engine/media-api.mjs', import.meta.url))

test('贴文污染防护：复制界面文本的长贴文即使夹带"做个图"也不触发自动出图', () => {
  const quoted = `语
思考过程
第二轮收官 ✅

📎 交付： D:\\pi-workspace\\生成物\\图片\\2026-09-20\\深夜修bug的浪漫_机械蝴蝶与代码之翼_1903.png（0.99 MB，落盘验证通过）

过程对照单：

步骤	结果
① 构思	"深夜修 bug 的浪漫"
② 提示词	五层
③ 通道预判	方图 1024
④ 验证	PIL 落盘核验

今晚两轮演示下来，我的出图全过程你已经看了个遍。

图片1 图片2 图片3
那你再做个图试试`.repeat(3)
  assert.ok(quoted.length > 300, '用例本身应是长贴文')
  const intents = detectMediaIntents(quoted)
  assert.equal(intents.filter(i => i.type === 'image').length, 0, '贴文不该触发自动出图')
})

test('回归：正常短指令仍然触发', () => {
  assert.ok(detectMediaIntents('帮我画个日落的图').some(i => i.type === 'image'))
  assert.ok(detectMediaIntents('给这篇文章配个图').some(i => i.type === 'image'))
})

test('回归：真长提示词（无 UI 痕迹特征）不误杀', () => {
  const longPrompt = '超高品质、极写实、电影感十足的时尚艺术肖像作品，双人构图，两位成年东亚女性，敦煌飞天美学，浅米色极简摄影工作室背景，高端商业摄影质感，柔和暖色调灯影。'.repeat(12)
  assert.ok(longPrompt.length > 300)
  assert.ok(detectMediaIntents(longPrompt + ' 帮我画个图').some(i => i.type === 'image'), '无 UI 痕迹的长提示词应正常触发')
})
