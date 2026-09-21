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

// 2026-09-20 二次修（这条是上一版漏掉的缝）：
// 判据原来把 `pi-workspace` 和 `localhost:8787` 也当"贴文"特征，可真实的长提示词里带本机路径、
// 带本机地址太常见了。结果 462 字带路径的正常出图请求被静默吞掉，用户那头看着就是"出图功能丢了"。
// 只有**界面自己产出的转录标记**（思考过程 / 📎 交付 / 本轮主引擎 / 工具卡）才算贴文证据。
test('回归：长提示词里带本机路径/地址，仍必须出图', () => {
  // 注意括号：不括起来 `.repeat(4)` 只会作用在第二个字符串上（算出来 259 字，够不到 300 的判据）
  const longPrompt = ('画一张海报：主体是一位穿汉服的年轻女性，站在烟雨江南的石桥上，背景是黛瓦白墙与远处层叠的山峦，' +
    '清晨薄雾散射光，低饱和青灰配少量朱红点缀，竖版三分法构图，衣袂被风吹起，水面有细密涟漪与倒影，电影级质感。').repeat(4)
  assert.ok(longPrompt.length > 300, '用例本身应是长消息（原始句 ×4，别退成 300 整）')
  const withPath = longPrompt + ' 参考 D:\\pi-workspace\\生成物\\图片\\2026-09-20\\a.png'
  const withUrl = longPrompt + ' 取自 http://localhost:8787/static/a.png'
  assert.ok(withPath.length > 300 && withUrl.length > 300)
  assert.ok(detectMediaIntents(withPath).some(i => i.type === 'image'), '带本机文件路径的长提示词不该被吞')
  assert.ok(detectMediaIntents(withUrl).some(i => i.type === 'image'), '带本机地址的长提示词不该被吞')
})

test('贴文防护仍然有效：去掉判据里的路径特征后，真转录贴文照样不出图', () => {
  const dump = `语
思考过程
第二轮收官 ✅

📎 交付： D:\\pi-workspace\\生成物\\图片\\a.png（0.99 MB）

过程对照单：步骤 结果
那你再做个图试试`.repeat(4)
  assert.ok(dump.length > 300)
  assert.equal(detectMediaIntents(dump).filter(i => i.type === 'image').length, 0, '带 UI 转录标记的长贴文仍不该出图')
})
