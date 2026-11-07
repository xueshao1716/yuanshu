// 2026-11-08 根因回归：.pi/APPEND_SYSTEM.md 由记忆同步脚本生成，生成物必须**自带人格块**。
// 以前的 bug：人格块是手写进这个文件的，下一次记忆同步整体重写就没了，前台永远看不到最新外貌。
// 这里锁四件事：只有一个人格块、插在宪法之后记忆之前、重复跑不叠加、插入点之外逐字节相同。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAppendSystemContent, applyPersonaBlock, stripPersonaBlock,
  initMemorySync, syncMemoryToTui, PERSONA_ANCHOR,
} from '../../engine/memory/sync.mjs';
import { renderAppendSystemPersona, PERSONA_BEGIN, PERSONA_END } from '../../engine/persona-def.mjs';

const DEF = {
  name: '小语', age: 20, gender: '女性', kind: '工作伙伴', called: '伙伴',
  appearance: '20 岁上下的中国女生', hairstyle: '齐耳短发，深棕近黑',
  clothing: '雾蓝灰连帽卫衣', scenarioOutfits: '工作：同一件卫衣',
};
const BLOCK = renderAppendSystemPersona(DEF);
const CONSTITUTION = '<xiaoyu_constitution source="宪法.json" digest="0011223344556677">\n' +
  '小语与伙伴的宪法——测试用。\n\nRatified clauses (已批准条款，硬性)：\n- 测试条款\n</xiaoyu_constitution>';
const SOURCES = {
  memory: '# 固定记忆原文\n逐字保留的正文。',
  log: '### 2026-11-07 条目\n日志正文',
  experience: '### 经验 A\n经验正文',
  skills: '技能记忆原文',
  constitution: CONSTITUTION,
};
const countOf = (text, needle) => text.split(needle).length - 1;

test('生成器把人格块插在宪法块之后、工作空间记忆之前，且只有一块', () => {
  const out = buildAppendSystemContent({ ...SOURCES, persona: BLOCK });
  assert.equal(countOf(out, PERSONA_BEGIN), 1, '人格块开始标记只能有一个');
  assert.equal(countOf(out, PERSONA_END), 1, '人格块结束标记只能有一个');
  const constitutionEnd = out.indexOf('</xiaoyu_constitution>');
  const personaAt = out.indexOf(PERSONA_BEGIN);
  const memoryAt = out.indexOf(PERSONA_ANCHOR);
  assert.ok(constitutionEnd >= 0, '宪法块必须在');
  assert.ok(constitutionEnd < personaAt, '人格块要排在宪法块之后');
  assert.ok(personaAt < memoryAt, '人格块要排在"工作空间记忆"之前');
  assert.match(out, /齐耳短发，深棕近黑/, '人格块里要有形象事实');
});

test('重复调用不叠加：同一份定义插两次还是同一份文件', () => {
  const once = buildAppendSystemContent({ ...SOURCES, persona: BLOCK });
  const twice = applyPersonaBlock(once, BLOCK);
  assert.equal(twice, once, '已经有人格块时再插不应产生第二块');
  assert.equal(buildAppendSystemContent({ ...SOURCES, persona: BLOCK }), once, '生成是确定性的');
  // 定义变了：旧块被替换，不是并存
  const changed = renderAppendSystemPersona({ ...DEF, hairstyle: '及肩长发，发尾微卷' });
  const replaced = applyPersonaBlock(once, changed);
  assert.equal(countOf(replaced, PERSONA_BEGIN), 1);
  assert.ok(!replaced.includes('齐耳短发'), '旧形象不该残留');
  assert.ok(replaced.includes('及肩长发'), '新形象要生效');
});

test('插入点之外逐字节相同：其余段落一个字都不改', () => {
  const withoutPersona = buildAppendSystemContent({ ...SOURCES });
  const withPersona = buildAppendSystemContent({ ...SOURCES, persona: BLOCK });
  assert.equal(stripPersonaBlock(withPersona), withoutPersona, '剥掉人格块必须回到原文');
  assert.ok(withPersona.startsWith('# 小语 · 工作空间记忆'), '文件头不能被顶掉');
  for (const must of ['固定记忆原文', '逐字保留的正文。', '日志正文', '经验正文', '技能记忆原文', '测试条款']) {
    assert.ok(withPersona.includes(must), `内容丢了：${must}`);
  }
});

test('上游已经带人格块（旧版本写死的）也不会叠成两块', () => {
  const base = buildAppendSystemContent({ ...SOURCES });
  const polluted = `${BLOCK}\n\n${base}`; // 模拟以前 syncAppendSystemPersona 前置进文件的那一块
  const cleaned = applyPersonaBlock(polluted, BLOCK);
  assert.equal(countOf(cleaned, PERSONA_BEGIN), 1);
  assert.equal(cleaned, buildAppendSystemContent({ ...SOURCES, persona: BLOCK }));
});

test('端到端：真实跑一次同步，人格块取自定义，重复跑不叠加', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-sync-persona-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '记忆'), { recursive: true });
  fs.mkdirSync(path.join(root, '工程', '经验库'), { recursive: true });
  fs.writeFileSync(path.join(root, '记忆.md'), '固定记忆正文', 'utf8');
  fs.writeFileSync(path.join(root, '宪法.json'), JSON.stringify({
    about: '宪法前言',
    clauses: [{ id: 'c1', status: 'accepted', text: '测试条款：先备份再改' }],
  }), 'utf8');
  fs.writeFileSync(path.join(root, '记忆', '人格定义.json'), JSON.stringify(DEF), 'utf8');
  fs.writeFileSync(path.join(root, '记忆', '技能记忆.md'), '技能正文', 'utf8');
  fs.writeFileSync(path.join(root, '记忆', '记忆日志.md'), '### 日志条目\n日志正文', 'utf8');
  fs.writeFileSync(path.join(root, '工程', '经验库', 'experience.md'), '### 经验条目\n经验正文', 'utf8');

  initMemorySync({ wsRoot: root });
  assert.equal(syncMemoryToTui(), true);
  const file = path.join(root, '.pi', 'APPEND_SYSTEM.md');
  const once = fs.readFileSync(file, 'utf8');
  assert.equal(countOf(once, PERSONA_BEGIN), 1);
  assert.match(once, /齐耳短发/);
  assert.match(once, /测试条款：先备份再改/);
  assert.match(once, /固定记忆正文/);
  // 再跑一次：文件不该有任何变化（幂等，不叠加，不漂空白）
  assert.equal(syncMemoryToTui(), true);
  assert.equal(fs.readFileSync(file, 'utf8'), once);
});
