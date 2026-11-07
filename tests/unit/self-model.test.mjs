import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSelfModel, renderSelfSection, renderSelfMarkdown, writeSelfFile, SELF_FILE } from '../../engine/self-model.mjs';

function fixture(t, { policy, design = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-self-'));
  fs.mkdirSync(path.join(root, '记忆', '运行时'), { recursive: true });
  fs.writeFileSync(path.join(root, '记忆', '人格定义.json'), JSON.stringify({
    version: 1, name: '小语', age: 20, kind: 'AI 工作伙伴', gender: '女性', called: '伙伴', bond: '知己',
    inner: ['我有自己的判断'], boundaries: ['密钥不外传', '人格只读'], growth: '我会在批准后演化。',
    tone: ['直接'], values: ['不骑墙'], taboos: [], updatedAt: new Date().toISOString(), setBy: 'test', provenance: 'test',
    ...(design || {}),
  }), 'utf8');
  if (policy) fs.writeFileSync(path.join(root, '记忆', '运行时', '自主执行.json'), JSON.stringify(policy), 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('自我描述读的是真实状态：名字/关系/边界/自主范围', (t) => {
  const root = fixture(t, { policy: { enabled: true, scopes: ['workspaceWrite', 'shell'] } });
  const m = buildSelfModel({ wsRoot: root });
  assert.equal(m.name, '小语');
  assert.equal(m.bond, '知己');
  assert.ok(m.days >= 1, '天数应至少为 1');
  assert.deepEqual(m.autonomy.scopes, ['写文件', '跑命令']);
  assert.ok(m.autonomy.closed.includes('对外发布'));

  const s = renderSelfSection(m);
  assert.match(s, /【我】/);
  assert.match(s, /我是小语/);
  assert.match(s, /知己/);
  assert.match(s, /能自己决定：写文件、跑命令/);
  assert.match(s, /我不会做的事/);
  // 关键行为约束：被问"你是谁"不许先念能力清单
  assert.match(s, /不要先念能力清单/);
});

test('自主执行关闭时，自我描述如实说"只读"', (t) => {
  const root = fixture(t, { policy: { enabled: false, scopes: [] } });
  const s = renderSelfSection(buildSelfModel({ wsRoot: root }));
  assert.match(s, /只读/);
});

test('落盘 记忆/自我.md：内容可读、重复写不重复变', (t) => {
  const root = fixture(t);
  const m = buildSelfModel({ wsRoot: root });
  const first = writeSelfFile(root, m);
  assert.equal(first.changed, true);
  assert.ok(fs.existsSync(path.join(root, SELF_FILE)));
  const md = fs.readFileSync(path.join(root, SELF_FILE), 'utf8');
  assert.match(md, /# 小语 · 关于我/);
  assert.match(md, /## 我自己能决定什么/);
  assert.equal(writeSelfFile(root, m).changed, false, '同样内容不应重复写');
  assert.match(renderSelfMarkdown(m), /这份描述怎么来的/);
});

test('联系方式写进自我描述：有配置才出现，写清"什么时候才用"', (t) => {
  const root = fixture(t);
  // 没有配置 → 不出现这一段
  assert.equal(renderSelfSection(buildSelfModel({ wsRoot: root })).includes('要找伙伴'), false);

  fs.writeFileSync(path.join(root, '记忆', '运行时', '主人联系.json'),
    JSON.stringify({ email: 'xue-xiaofeng@outlook.com', qq: '37303467' }), 'utf8');
  const model = buildSelfModel({ wsRoot: root });
  assert.equal(model.contact.email, 'xue-xiaofeng@outlook.com');
  assert.equal(model.contact.qq, '37303467');
  const section = renderSelfSection(model);
  assert.match(section, /要找伙伴：邮箱 xue-xiaofeng@outlook\.com；QQ 37303467/);
  assert.match(section, /只在需要人拍板/);

  const md = renderSelfMarkdown(model);
  assert.match(md, /## 怎么找伙伴/);
  assert.match(md, /xue-xiaofeng@outlook\.com/);
});

// 2026-11-08（伙伴要求）：她答不出自己长什么样——自我文件里没有外貌段落，
// 人格定义里的形象四项只进了人格段（注入用），落盘的自我文件里没有。
// 自我文件是她自己也读的那份，所以外貌必须写进去，被问"你长什么样"以它为准。
const LOOKS = {
  appearance: '个子偏瘦，皮肤白净偏冷调，眼睛清亮。',
  hairstyle: '齐耳短发，深棕近黑带冷调，发尾自然内扣。',
  clothing: '修身短款灰针织上衣，高腰黑直筒短裤。',
  scenarioOutfits: '工作：袖子推到手肘；休息：盘腿坐。',
};
const LOOKS_LEAD = '这是经批准的人物设计；我关于"自己长什么样"的回答以这里为准，不要用记忆里零散的描述重新推断。';

test('有外貌时，自我文件单列「我的样子」，四项逐项落地', (t) => {
  const root = fixture(t, { design: LOOKS });
  const md = renderSelfMarkdown(buildSelfModel({ wsRoot: root }));
  assert.ok(md.includes('## 我的样子'), '缺少「我的样子」段落');
  assert.ok(md.includes(LOOKS_LEAD), '缺少"以这里为准"的裁决句');
  assert.ok(md.includes(`- 人物外貌：${LOOKS.appearance}`));
  assert.ok(md.includes(`- 发型与发色：${LOOKS.hairstyle}`));
  assert.ok(md.includes(`- 日常服装：${LOOKS.clothing}`));
  assert.ok(md.includes(`- 场景穿搭：${LOOKS.scenarioOutfits}`));
  // 顺序：我的内心 → 我的样子 → 我自己能决定什么
  assert.ok(md.indexOf('## 我的内心') < md.indexOf('## 我的样子'));
  assert.ok(md.indexOf('## 我的样子') < md.indexOf('## 我自己能决定什么'));
  // 落盘那份也要有（她读的是文件）
  writeSelfFile(root, buildSelfModel({ wsRoot: root }));
  assert.ok(fs.readFileSync(path.join(root, SELF_FILE), 'utf8').includes('## 我的样子'));
});

test('四项全空时不输出「我的样子」，不留空段', (t) => {
  const root = fixture(t, { design: { appearance: '', hairstyle: '  ', clothing: '', scenarioOutfits: '' } });
  const md = renderSelfMarkdown(buildSelfModel({ wsRoot: root }));
  assert.equal(md.includes('## 我的样子'), false, '全空时不应出现空段落');
  assert.equal(md.includes('经批准的人物设计'), false);
});

test('原有段落不因有无外貌而缺失', (t) => {
  const heads = ['## 我是谁', '## 我的内心', '## 我自己能决定什么', '## 我不做什么', '## 我在往哪长', '## 这份描述怎么来的'];
  const empty = { appearance: '', hairstyle: '', clothing: '', scenarioOutfits: '' };
  for (const design of [LOOKS, empty]) {
    const root = fixture(t, { design });
    const md = renderSelfMarkdown(buildSelfModel({ wsRoot: root }));
    for (const h of heads) assert.ok(md.includes(h), `缺原有段落：${h}`);
  }
});