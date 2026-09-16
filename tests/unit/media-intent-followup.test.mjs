// ④ 出图兜底的回归测试。
//
// 真机现象："用 Agnes 聊天让画图，经常不画"。
// 根因一：宿主旁路出图（media-api 的 detectMediaIntents）只认关键词；用户上一轮在出图、
//   这一轮只说"再换个词的出一下"（真机原话）时检测不到 → 旁路不出图，模型又不主动调工具 → 什么都不画。
// 根因二（同一次验证里发现的）：从工具输出里刮出来的媒体**没走本地化契约**就被推给前端，
//   外站临时链接直接进了对话，过期就是裂图。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectMediaIntents, isFollowUpDrawRequest, extractMediaPrompt } from '../../engine/media-api.mjs';

test('④ 续画意图：上一轮出过图时，"再换个词的出一下"要认出来（真机原话）', () => {
  const real = '这个就有那么点意思，不管字对不对，效果对了，再换个词的出一下';
  assert.equal(detectMediaIntents(real).length, 0, '没有上下文时确实检测不到——这就是"经常不画"的根因');
  const withCtx = detectMediaIntents(real, { lastMediaType: 'image', lastPrompt: '巨号跑鞋广告海报' });
  assert.equal(withCtx.length, 1);
  assert.equal(withCtx[0].type, 'image');
  assert.equal(withCtx[0].followUp, true, '要标成续画，提示词才沿用上一轮');
  assert.equal(
    extractMediaPrompt(real, { followUp: true, lastPrompt: '巨号跑鞋广告海报' }),
    '巨号跑鞋广告海报',
    '续画沿用上一轮真正用过的那句，不要把"换个词的出一下"当提示词',
  );
});

test('④ 续画意图不能误伤：闲聊 / 工程追问 / 否定句 / 上一轮没出过图都不算', () => {
  assert.equal(detectMediaIntents('再改一下代码', { lastMediaType: 'image' }).length, 0);
  assert.equal(detectMediaIntents('再跑一遍测试', { lastMediaType: 'image' }).length, 0);
  assert.equal(detectMediaIntents('不用再画了', { lastMediaType: 'image' }).length, 0);
  assert.equal(detectMediaIntents('再来一张', { lastMediaType: '' }).length, 0, '上一轮没出过图就不许自作主张画');
  assert.equal(detectMediaIntents('再来一张', { lastMediaType: 'image' })[0].followUp, true);
  assert.equal(detectMediaIntents('重画一下这张', { lastMediaType: 'image' })[0].type, 'image');
  assert.equal(isFollowUpDrawRequest('这个就有那么点意思，不管字对不对，效果对了，再换个词的出一下'), true);
});

test('④ 明确要图的老路子没被改坏', () => {
  assert.equal(detectMediaIntents('帮我画一张猫')[0].type, 'image');
  assert.equal(detectMediaIntents('配个图')[0].type, 'image');
  assert.equal(detectMediaIntents('做个视频')[0].type, 'video');
  assert.equal(detectMediaIntents('配音一下')[0].type, 'tts');
});

test('④ 工具输出里刮出来的媒体也要本地化（外站链接会过期）', () => {
  const srv = fs.readFileSync('server.mjs', 'utf8');
  assert.match(srv, /const pushScraped = async \(type, url\)/, '刮出来的媒体要统一走一个出口');
  assert.match(srv, /saveArtifact\(\{ type, url \}\)/, '必须先 saveArtifact 再推给前端');
  assert.match(srv, /localizeError \? \{ localizeError \}/, '没落地的要标出来，界面才分辨得出');
  assert.ok(!/writer\.push\("media", \{ type: "image", url \}\)/.test(srv), '不许再直接把外站链接推给前端');
});
