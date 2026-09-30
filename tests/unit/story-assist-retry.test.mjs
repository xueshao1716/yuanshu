// 智能填充的**重试与换模型**顺序。
//
// 用户报的是「智能填充返回的内容不是有效 JSON」。解析宽容了是一半，另一半是：
// 遇到这种情况该**先让同一个模型再答一次**（把"只输出 JSON"说到不能再直白），
// 再换备选模型——换模型往往更慢更贵，不该是第一反应。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleStoryAssist } from '../../engine/story-orchestrator.mjs';
import { createProject, writeProject } from '../../engine/story-store.mjs';

const answer = '{"characters":[{"name":"阿宁"}],"scene":{"title":"站台","summary":"雨夜"},"beat":{"kind":"video","prompt":"她抬头","dialogue":"阿宁：你为什么不走？"}}';

function fakeRes() {
  const out = { status: 0, body: null };
  out.res = { writeHead(code) { out.status = code }, setHeader() {}, end(text) { out.body = text ? JSON.parse(text) : null } };
  return out;
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-assist-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeProject(root, createProject({ title: '雾海列车', logline: '找父亲', bible: { characters: [], locations: [], props: [], wardrobe: [], style: {}, rules: [] }, scenes: [] }, { id: () => 'pa' }));
  return root;
}

const ctxWith = (root, calls, reply) => ({
  root,
  directChat: async (model, prompt) => { calls.push({ model: model.id, prompt }); return reply(model, prompt) },
  getModelList: () => [{ provider: 'p', id: 'agnes-3.0-flash', capabilities: { chat: true } }],
  getDefaultModel: () => ({ provider: 'p', id: 'agnes-3.0-flash' }),
});

test('第一次答非 JSON：同一个模型再要一次（带"只输出 JSON"的硬要求），成功了就不换模型', async (t) => {
  const root = await setup(t);
  const calls = [];
  const res = fakeRes();
  await handleStoryAssist(ctxWith(root, calls, (_m, prompt) => ({ text: prompt.includes('【补充要求】') ? answer : '好的，我先梳理一下这个故事……' })), res.res, 'pa', { idea: '雨夜开场' });
  assert.equal(calls.length, 2, '要重试，而不是一次失败就换模型');
  assert.equal(calls[0].model, calls[1].model, '第二次还是同一个模型');
  assert.ok(!calls[0].prompt.includes('【补充要求】'), '第一次用原始提示词');
  assert.match(calls[1].prompt, /【补充要求】/);
  assert.match(calls[1].prompt, /只输出那一个 JSON 对象/);
  assert.match(calls[1].prompt, /不要开场白/, '要把"不要说什么"说清楚，而不是重复一遍"只返回 JSON"');
  assert.equal(res.body.assist.characters[0].name, '阿宁');
  assert.equal(res.body.retried, true, '重试过就要如实告诉界面');
  assert.equal(res.body.model.id, 'agnes-3.0-flash');
});

test('自动模式两次都不是 JSON：才换备选模型；全失败时错误里要有线索和下一步', async (t) => {
  const root = await setup(t);
  const calls = [];
  const res = fakeRes();
  const ctx = {
    root,
    directChat: async (model, prompt) => { calls.push(model.id); return { text: model.id === 'm2' ? answer : '这不是 JSON' } },
    getModelList: () => [{ provider: 'p', id: 'm1', capabilities: { chat: true } }, { provider: 'p', id: 'm2', capabilities: { chat: true } }],
    getDefaultModel: () => ({ provider: 'p', id: 'm2' }),
  };
  await handleStoryAssist(ctx, res.res, 'pa', { idea: '雨夜开场' });
  assert.deepEqual(calls, ['m1', 'm1', 'm2'], '同一个模型两次之后才换备选');
  assert.equal(res.body.assist.scene.title, '站台');

  // 全失败：错误要带原文线索 + 下一步，且是 502（模型侧问题，不是用户输入问题）
  // 注意 handleStoryAssist 会把错误转成响应（不往外抛），所以断言的是响应。
  const calls2 = [];
  const res2 = fakeRes();
  await handleStoryAssist({ ...ctx, directChat: async (model) => { calls2.push(model.id); return { text: '我做不到。' } } }, res2.res, 'pa', { idea: '雨夜开场' });
  assert.equal(res2.status, 502, '模型侧的问题不该报成 400(用户输入错)');
  assert.match(String(res2.body.error), /找不到 JSON/, '要说清是"找不到 JSON"');
  assert.match(String(res2.body.error), /我做不到/, '要带原文开头当线索');
  assert.match(String(res2.body.error), /换一个构思模型/, '要给出下一步');
  assert.equal(calls2.length, 4, '两个模型各试两次');
});

test('自动模式没返回内容（空文本）时不浪费重试：直接换下一个模型', async (t) => {
  const root = await setup(t);
  const calls = [];
  const ctx = {
    root,
    directChat: async (model) => { calls.push(model.id); return model.id === 'm1' ? { text: '' } : { text: answer } },
    getModelList: () => [{ provider: 'p', id: 'm1', capabilities: { chat: true } }, { provider: 'p', id: 'm2', capabilities: { chat: true } }],
    getDefaultModel: () => ({ provider: 'p', id: 'm2' }),
  };
  const res = fakeRes();
  await handleStoryAssist(ctx, res.res, 'pa', { idea: '雨夜开场' });
  assert.deepEqual(calls, ['m1', 'm2'], '空回复重试也是空，没必要再问一次同一个模型');
  assert.equal(res.body.assist.beat.prompt, '她抬头');
});
