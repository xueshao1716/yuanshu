import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryAssistPrompt, parseStoryAssist, buildStoryboardPrompt } from '../../engine/story-assist.mjs';

// 配色卡要在**分镜那一刻**就进提示词：等生成时再覆盖 shot.tone 只是打补丁，
// 分镜里写的画面描述已经歪了。
test('一键分镜：项目选了配色卡就写进分镜提示词，没选就不占位置', () => {
  const withCard = buildStoryboardPrompt({ title: '雾海列车', count: 4, colorCard: 'morandi-violet-pink' });
  assert.match(withCard, /【本片配色】莫兰迪高级灰 · 蓝紫粉/);
  assert.match(withCard, /#6453A1/);
  assert.match(withCard, /shot\.tone/, '要说清往哪个字段写，否则模型只会写进 prompt 散文里');
  assert.match(withCard, /不要荧光色与高饱和撞色/);

  const without = buildStoryboardPrompt({ title: '雾海列车', count: 4 });
  assert.doesNotMatch(without, /【本片配色】/);
});

test('story assist prompt clearly assigns AI draft and human approval', () => {
  const prompt = buildStoryAssistPrompt({ title: '雾海列车', idea: '一场跨海追逐' });
  assert.match(prompt, /人类确认/);
  assert.match(prompt, /雾海列车/);
  assert.match(prompt, /characters/);
});

test('story assist parses fenced JSON and keeps only editable fields', () => {
  const result = parseStoryAssist('```json\n{"characters":[{"name":"阿宁"}],"style":{"visual":"电影感"},"rules":[{"text":"左手戴表"}],"scene":{"title":"车站","summary":"雨夜"},"beat":{"kind":"image","prompt":"回头"}}\n```');
  assert.equal(result.characters[0].name, '阿宁');
  assert.equal(result.style.visual, '电影感');
  assert.equal(result.scene.title, '车站');
  assert.equal(result.beat.kind, 'image');
});

// 用户真实报过的一条：「智能填充返回的内容不是有效 JSON」。
// 根因是**同一个文件里两套宽容度**：一键分镜/原著改编早就能从
// "先复述一段再给 JSON" 里把答案抠出来，智能填充却只做一次 JSON.parse。
// 这几条把这个不一致钉住：assist 的解析必须和另外两个一样宽容。
test('智能填充的解析要和分镜/改编一样宽容：多说一句话不该把用户堵死', () => {
  const answer = '{"characters":[{"name":"阿宁","appearance":"短发"}],"scene":{"title":"站台","summary":"雨夜"},"beat":{"kind":"video","prompt":"她抬头","dialogue":"阿宁：你为什么不走？"}}';

  // ① 前后各写一段解释（最常见：模型先说"好的，以下是草稿"）
  const chatty = parseStoryAssist(`好的，我来补一份可编辑草稿：\n\n${answer}\n\n以上内容请确认后再保存。`);
  assert.equal(chatty.characters[0].name, '阿宁');
  assert.equal(chatty.beat.dialogue, '阿宁：你为什么不走？');

  // ② 包一层 draft / data / result
  assert.equal(parseStoryAssist(JSON.stringify({ draft: JSON.parse(answer) })).scene.title, '站台');
  assert.equal(parseStoryAssist(JSON.stringify({ data: JSON.parse(answer) })).beat.prompt, '她抬头');
  assert.equal(parseStoryAssist(JSON.stringify({ result: JSON.parse(answer) })).characters[0].appearance, '短发');

  // ③ 先把提示词里的"已有状态"复述一遍再给答案——取第一个 JSON 就会拿错，
  //    这正是 storyboard 当年踩过的坑（顶层键看着像设定，其实不是答案）
  const echo = `已读到的设定：{"characters":[{"name":"路人甲"}]}\n\n这是我的草稿：${answer}`;
  const picked = parseStoryAssist(echo);
  assert.equal(picked.characters[0].name, '阿宁', '要挑**真能解析出内容**的那一个，而不是第一个 JSON');
  assert.equal(picked.scene.summary, '雨夜');

  // ④ 只有台词没有画面描述也算内容（台词是硬内容，画面可以后补）
  assert.equal(parseStoryAssist('{"beat":{"dialogue":"老周：走哪儿。"}}').beat.dialogue, '老周：走哪儿。');
});

test('智能填充解析不出来时，报错要带上线索（试过什么、原文开头），不能只说"不是有效 JSON"', () => {
  // 完全没有 JSON：错误里要有原文开头，用户/我才能判断是模型跑偏还是形状不符
  assert.throws(() => parseStoryAssist('我觉得这个故事应该从雨夜开始。'), /找不到 JSON.*我觉得这个故事应该从雨夜开始/s);
  assert.throws(() => parseStoryAssist(''), /找不到 JSON/);
  // 有 JSON 但内容是空的（模型回 {} 或只有一句 error）：不能"解析成功"然后给一份空草稿
  assert.throws(() => parseStoryAssist('{"error":"无法完成"}'), /没有可用内容.*error/s);
  assert.throws(() => parseStoryAssist('{}'), /没有可用内容/);
  // 报错要给出下一步，而不是把用户留在原地
  assert.throws(() => parseStoryAssist('{}'), /换一个构思模型/);
});

