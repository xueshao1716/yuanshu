// 行为信号（behaviorCues）：只在有结构证据时补 task_deep / user_frustrated，只喂基因，不改情绪。
// 误判用例全部取自 2026-10-05 对真实会话的核对，防止回到「为什么=受挫」「长消息=重活」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { behaviorCues, cueText, cueMatches } from '../../engine/emotion-cues.mjs';
import * as emotion from '../../engine/emotion.mjs';

for (const msg of [
  '为什么天是蓝的？', '今天吃什么？去哪玩？', '这个怎么样？好看吗？', '问题都修完了吗', '那你继续',
  '帮我验证一下这个想法', '帮我定位一下北京', '实现了，挺好', '写实手机摄影合照，9:16竖构图，室内展会现场，一位20岁成年东方女性模特靠近镜头自然自拍，五官清秀，自然光',
  '你为啥很少画亚洲女性', '有两个问题，底图你为什么选择左边空白的左右式',
]) test(`不打行为标签：${msg.slice(0, 20)}`, () => assert.deepEqual(behaviorCues(msg), []));

for (const [msg, tag] of [
  ['```js\nconst a = 1\n```\n看下这段', 'task_deep'],
  ['看下 engine/emotion.mjs 第 300 行', 'task_deep'],
  ['怎么一直报 Error: Concurrency limit exceeded', 'task_deep'],
  ['前端 tsc 报 TS5102', 'task_deep'],
  ['这个接口的参数和返回值对不上', 'task_deep'],
  ['又挂了', 'user_frustrated'], ['还是不行', 'user_frustrated'], ['怎么又400', 'user_frustrated'],
  ['你怎么回事，咋这么卡', 'user_frustrated'], ['tui端怎么用不了gpt系列', 'user_frustrated'], ['上个窗口卡死了', 'user_frustrated'],
]) test(`打 ${tag}：${msg.slice(0, 20)}`, () => assert.ok(behaviorCues(msg).includes(tag), JSON.stringify(behaviorCues(msg))));

test('单个技术词不算重活，两个不同技术词才算', () => {
  assert.deepEqual(behaviorCues('帮我写个函数'), []);
  assert.deepEqual(behaviorCues('这个函数函数函数'), []);
  assert.ok(behaviorCues('这个函数的参数不对').includes('task_deep'));
});

test('引用/行内代码里的失败说法不算用户受挫', () => {
  assert.deepEqual(behaviorCues('文档里写着“又挂了”这句提示'), []);
  assert.deepEqual(behaviorCues('把 `还是不行` 这句文案改掉'), []);
});

test('词表不再收歧义词：没用过 / 行不行 / 定位 / 为什么 不触发', () => {
  const src = fs.readFileSync(new URL('../../engine/emotion.mjs', import.meta.url), 'utf8');
  const KW = eval('[' + src.match(/const KEYWORDS = \[([\s\S]*?)\n\];/)[1] + ']');
  const hit = (t) => KW.filter(([w, , , , tag]) => cueMatches(cueText(t), w, tag)).map(([w]) => w);
  for (const t of ['我没用过这个', '行不行都可以', '我没用完啊', '帮我定位一下北京', '为什么天是蓝的', '实现了，挺好', '那你一边验证一边补吧']) assert.deepEqual(hit(t), [], t);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-cues-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  emotion.init(root);
  return { sid: `cues-${Math.random()}`, read: () => JSON.parse(fs.readFileSync(path.join(root, '工程/经验库/genome.json'), 'utf8')) };
}

test('行为标签进基因观测，但不进情绪 tags、不动情绪向量', t => {
  const { sid, read } = fixture(t);
  const before = { ...emotion.getSnapshot(sid) };
  emotion.updateEmotion(sid, '看下 engine/emotion.mjs，这个接口参数不对', { turnId: 'a' });
  const snap = emotion.getSnapshot(sid);
  assert.ok(!snap.tags.includes('task_deep'), '行为标签不得进情绪 tags');
  const events = read().observations.events;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].tags, ['task_deep']);
  assert.equal(typeof before.valence, 'number');
});

test('纯好奇提问不产生基因事件', t => {
  const { sid, read } = fixture(t);
  emotion.updateEmotion(sid, '为什么天是蓝的？晚霞为什么是红的？', { turnId: 'a' });
  let events = [];
  try { events = read().observations.events || []; } catch {}
  assert.equal(events.length, 0);
});
