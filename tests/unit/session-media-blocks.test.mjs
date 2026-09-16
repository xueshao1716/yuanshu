// ③ 的回归测试：assistant 消息里的附件块会让 pi SDK 重放历史时抛
//   TypeError: Cannot read properties of undefined (reading 'length')
// （pi-ai/dist/utils/estimate.js:42 把非 text/thinking 的块当工具调用读 block.name.length）。
// 这里锁两件互相牵制的事：
//   ① 落盘前必须"SDK 安全化"——附件块不许留在 content 里；
//   ② 改写之后界面照样看得见图——extractImages 要能从文本里的 markdown 图片抠回来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sdkSafeAssistantBlocks } from '../../engine/yuanshu-session.mjs';
import { extractImages } from '../../engine/session-utils.mjs';

test('落盘改写：assistant 内容里的附件块必须变成纯文本，工具调用与思考块原样保留', () => {
  const safe = sdkSafeAssistantBlocks([
    { type: 'text', text: '收到，我自己跑一张。' },
    { type: 'image', url: '/api/ws/file?path=x.png' },
  ]);
  assert.deepEqual(safe.map(b => b.type), ['text', 'text'], '不允许再把 image 块写进 assistant content');
  assert.match(safe[1].text, /!\[图片\]\(\/api\/ws\/file\?path=x\.png\)/, '图片要变成 markdown，URL 不能丢');

  // 工具调用 / 思考块不能被动：SDK 要靠 toolCall 和 toolResult 配对
  const keep = [{ type: 'thinking', thinking: '嗯' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: '{}' }];
  assert.deepEqual(sdkSafeAssistantBlocks(keep), keep);

  // 视频/音频/文件同理；没有 url 就退化成文字说明
  assert.match(sdkSafeAssistantBlocks([{ type: 'video', url: '/v.mp4' }])[0].text, /!\[视频\]\(\/v\.mp4\)/);
  assert.match(sdkSafeAssistantBlocks([{ type: 'file', path: 'a.txt' }])[0].text, /\[文件\] a\.txt/);

  // 例外：带 name 的 file 块原样保留——估算器读 block.name.length（有 name 就安全），
  // 而界面靠 type:"file" 渲染文件卡片，转成文本会把卡片弄丢。
  const named = { type: 'file', name: 'a.txt', path: 'a.txt', size: 1, mime: 'text/plain' };
  assert.deepEqual(sdkSafeAssistantBlocks([named]), [named]);

  // 全被丢掉时也要留一个合法块：空 content 在 SDK 那边同样是脏数据
  assert.deepEqual(sdkSafeAssistantBlocks([{ type: 'nonsense' }]), [{ type: 'text', text: '' }]);
  assert.deepEqual(sdkSafeAssistantBlocks([]), [{ type: 'text', text: '' }]);
});

test('改写之后界面仍能取到图：extractImages 认文本里的 markdown 图片，且不重复', () => {
  const after = [{ type: 'text', text: '跑完了：\n\n![图片](/api/ws/file?path=x.png)\n' }];
  assert.deepEqual(extractImages(after), [{ url: '/api/ws/file?path=x.png' }]);

  // 老数据（image 块）继续认
  assert.deepEqual(extractImages([{ type: 'image', url: '/a.png' }]), [{ url: '/a.png' }]);
  // 同一个 URL 出现在块和文本里只算一次
  assert.deepEqual(extractImages([{ type: 'image', url: '/a.png' }, { type: 'text', text: '![图片](/a.png)' }]), [{ url: '/a.png' }]);
  // 字符串 content 也认（历史上有的会话就是纯文本）
  assert.deepEqual(extractImages('看这张 ![图片](/b.png)'), [{ url: '/b.png' }]);
  // 普通文件链接不能被当成图片（否则界面会出现裂图）
  assert.deepEqual(extractImages([{ type: 'text', text: '产物：/api/ws/file?path=a.mp4' }]), []);
});
