// 真机 bug 回归（2026-09-18）："刷新或者更换终端打开后，之前会话里的图片、视频这些就看不到了"
//
// 两个成因：
//   ① 旁路出图/出片的产物落在**工具结果**里（`✅ 已生成 image：https://…/xx.png`），
//      而工具结果不进历史（extractMessages 只出 user/assistant）→ 刷新后图全没了；
//   ② 落盘把附件块改写成 markdown 时视频写成 `![视频](x.mp4)`，
//      extractImages 把它当图片收下（界面渲染裂图），真正该在 videos 里的又容易看着像丢了。
//
// 这个测试锁：媒体工具的产物能在历史里回放；视频不再被当成图片；搜索结果里的图不会被误当产物。
// 2026-11-08 收紧：只有**本地存档**的图能回放。工具结果里的厂商临时地址（platform-outputs…）
// 当年没落盘，现在多半已经失效，历史里不再渲染，只留一行"当年未落盘"的说明。
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMessages, extractImages, extractVideos, mediaFromToolResult, isMediaTool, isVideoUrl, isAudioUrl } from '../../engine/session/utils.mjs';

// 带 parentId 链，模拟真实会话：assistant → toolResult
const assistantWithCall = (id, name) => ({
  type: 'message', id: 'a_' + id, parentId: 'root', timestamp: '2026-09-18T10:50:00.000Z',
  message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: '{}' }] },
});
const toolResult = (id, text) => ({
  type: 'message', id: 't_' + id, parentId: 'a_' + id, timestamp: '2026-09-18T10:50:01.000Z',
  message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }] },
});

test('媒体工具的结果（本地存档图）刷新后仍在历史里；厂商图不再渲染', () => {
  const local = '/api/ws/file?path=' + encodeURIComponent('生成物/图片/海报.png');
  const entries = [assistantWithCall('c1', 'generate_image'), toolResult('c1', `✅ 已生成 image：${local}`)];
  // 走叶链（刷新时前端拿的就是这条路径）
  const msgs = extractMessages(entries, 't_c1');
  const a = msgs.find(m => m.role === 'assistant');
  assert.ok(a, '这条 assistant 必须在叶链上（parentId 链要对）');
  assert.deepEqual(a.images, [local], '落盘的图必须挂在这条 assistant 上，刷新后才看得见');
  // 不传 leafId 也要一样
  assert.deepEqual(extractMessages(entries).find(m => m.role === 'assistant').images, [local]);

  // 旧会话里存的是厂商临时地址：不渲染，只留一行说明
  const remote = 'https://platform-outputs.agnes-ai.space/images/t2i/task_FQkkix5OuDRmkDmc9yRp0HXyOgTrOoV2/output_40a64c846ebd4901ac01af7cfbd6804a.png';
  const oldEntries = [assistantWithCall('c2', 'generate_image'), toolResult('c2', `✅ 已生成 image：${remote}`)];
  const a2 = extractMessages(oldEntries, 't_c2').find(m => m.role === 'assistant');
  assert.deepEqual(a2.images, [], '厂商地址随时可能被关，不能再放进聊天');
  assert.match(a2.text, /当年未落盘/, '要说明这张图为什么不见了');
});

test('视频不再被当成图片；本地 /api/ws/file 的产物同样能回放', () => {
  const mp4 = '/api/ws/file?path=%E7%94%9F%E6%88%90%E7%89%A9%2F%E8%A7%86%E9%A2%91%2F2026-09-18%2F2B-%E6%BC%AB%E5%B1%95%E5%81%B7%E6%8B%8D%E6%84%9F.mp4';
  // ① 落盘形态：assistant 正文里的 `![视频](x.mp4)`
  assert.deepEqual(extractImages([{ type: 'text', text: `跑完了：\n\n![视频](${mp4})\n` }]), [], 'markdown 里的 .mp4 不许再进 images（否则界面渲染裂图）');
  assert.deepEqual(extractVideos([{ type: 'text', text: `![视频](${mp4})` }]), [mp4], '要进 videos');

  // ② 工具结果形态：generate_video 返回本地路径
  const entries = [assistantWithCall('v1', 'generate_video'), toolResult('v1', `✅ 已生成 video：${mp4}`)];
  const a = extractMessages(entries, 't_v1').find(m => m.role === 'assistant');
  assert.deepEqual(a.videos, [mp4]);
  assert.deepEqual(a.images, [], '视频不许混进 images');

  // ③ 判别函数本身
  assert.equal(isVideoUrl(mp4), true);
  assert.equal(isAudioUrl('/x/voice.mp3'), true);
  assert.equal(isVideoUrl('/x/pic.png'), false);
  assert.equal(isMediaTool('generate_image'), true);
  assert.equal(isMediaTool('web_search'), false);
  assert.equal(isMediaTool('search_files'), false);
});

test('搜索结果里的图不会被误当产物（只认媒体工具的结果）', () => {
  const entries = [assistantWithCall('s1', 'web_search'), toolResult('s1', '1. 示例 https://www.bing.com/sa/simg/facebook_sharing_5.png')];
  const a = extractMessages(entries, 't_s1').find(m => m.role === 'assistant');
  assert.deepEqual(a.images, [], '搜索结果的分享图不是产物');

  // 但同一段 URL 若是媒体工具返回的，就收
  assert.deepEqual(mediaFromToolResult([{ type: 'text', text: 'https://cdn.example.com/a.png' }]).images, ['https://cdn.example.com/a.png']);
});

test('工具结果里的 base64 不收（避免把 read 出来的图回灌进历史）', () => {
  assert.deepEqual(mediaFromToolResult([{ type: 'image', data: 'A'.repeat(5000), mimeType: 'image/png' }]), { images: [], videos: [], audios: [] }, '没有 URL 的图块不进历史');
  assert.deepEqual(mediaFromToolResult([{ type: 'image', url: 'https://x/y.png' }]).images, ['https://x/y.png']);
});
