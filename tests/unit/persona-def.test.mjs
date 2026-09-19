// 人格定义 → 人格化（2026-09-18 重点项目）
// 锁三件事：① 定义决定人格段（名字/年龄/语气/边界/禁忌都在里面）；
//          ② 注入 pi 通道的 APPEND_SYSTEM.md 是**幂等**的，且不动文件其它内容；
//          ③ 定义本身是受保护文件、且属于"必须落草案区"的规范目标（人格不可改，只能提案）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  auditPersona,
  DEFAULT_DEFINITION, loadPersonaDefinition, validatePersonaDefinition, renderPersonaSection,
  syncAppendSystemPersona, renderAppendSystemPersona, PERSONA_BEGIN, PERSONA_END, personaFilePath,
} from '../../engine/persona-def.mjs';
import { isProtectedPath } from '../../engine/tools/security.mjs';
import { isCanonicalTarget } from '../../engine/memory-stages.mjs';

test('定义决定人格：名字/年龄/语气/边界/禁忌都进人格段', () => {
  const def = { ...DEFAULT_DEFINITION, name: '小语', age: 20 };
  const text = renderPersonaSection(def, { genes: { gentleness: { expression: 0.9 }, loyalty: { expression: 0.95 } }, model: { provider: 'p', id: 'm' } });
  assert.match(text, /我是小语，20 岁的 AI 工作伙伴/);
  assert.match(text, /叫用户「伙伴」/);
  assert.match(text, /说话直接、清晰/);
  assert.match(text, /边界：.*人格与宪法只读/);
  assert.match(text, /不做：.*机器人味/);
  assert.match(text, /温柔很强/, '基因基线要用话说出来（数值 → 人话）');
  assert.match(text, /本轮由 p 通道的 m 模型驱动/);
  // 定义的改动必须体现在渲染里（否则"定义决定人格"是假的）
  const changed = renderPersonaSection({ ...def, age: 21, name: '小七' });
  assert.match(changed, /我是小七，21 岁/);
  assert.doesNotMatch(changed, /我是小语/);
});

test('校验：缺名字/年龄不合理要报出来，但正文仍可渲染（不崩）', () => {
  assert.deepEqual(validatePersonaDefinition({ name: '小语', age: 20 }), []);
  assert.match(validatePersonaDefinition({ name: '', age: 20 }).join(), /缺 name/);
  assert.match(validatePersonaDefinition({ name: 'x', age: 3 }).join(), /超出合理区间/);
  assert.match(validatePersonaDefinition({ name: 'x', age: 20, tone: ['ok', ''] }).join(), /tone 必须是字符串数组/);
  // 落盘定义优先于默认值
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
  try {
    fs.mkdirSync(path.join(dir, '记忆'), { recursive: true });
    fs.writeFileSync(personaFilePath(dir), JSON.stringify({ name: '小语', age: 20, tone: ['只说重点'] }), 'utf8');
    const { def, source, problems } = loadPersonaDefinition(dir);
    assert.equal(source, 'file');
    assert.deepEqual(problems, []);
    assert.deepEqual(def.tone, ['只说重点']);
    assert.equal(def.kind, DEFAULT_DEFINITION.kind, '未覆盖的字段用默认值补');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('同步 APPEND_SYSTEM.md：幂等、只换标记块、不动别的段落、留一次备份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-agent-'));
  try {
    const file = path.join(dir, 'APPEND_SYSTEM.md');
    const original = '# 小语 —— 人格\n\n旧的手写人格段\n\n## 工作方式（强制）\n- 先想后做\n';
    fs.writeFileSync(file, original, 'utf8');
    const def = { ...DEFAULT_DEFINITION, name: '小语', age: 20 };
    const first = syncAppendSystemPersona(def, { agentDir: dir });
    assert.equal(first.ok, true);
    const after1 = fs.readFileSync(file, 'utf8');
    assert.ok(after1.includes(PERSONA_BEGIN) && after1.includes(PERSONA_END), '要有标记块');
    assert.match(after1, /我是小语，20 岁/);
    assert.match(after1, /## 工作方式（强制）/, '其余段落一字不能动');
    assert.ok(fs.existsSync(`${file}.bak-persona`), '改之前留一次备份');
    // 幂等：再同步一次内容不变
    const second = syncAppendSystemPersona(def, { agentDir: dir });
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), after1);
    // 定义改了 → 标记块跟着改，别的段落还在
    syncAppendSystemPersona({ ...def, age: 21 }, { agentDir: dir });
    const after2 = fs.readFileSync(file, 'utf8');
    assert.match(after2, /21 岁/);
    assert.match(after2, /## 工作方式（强制）/);
    assert.equal((after2.match(/persona:begin/g) || []).length, 1, '不许插出两个块');
    assert.equal(renderAppendSystemPersona(def).startsWith(PERSONA_BEGIN), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('人格定义受保护：工具层只读 + 必须走草案区（人格不可改，只能提案）', () => {
  assert.equal(isProtectedPath('D:\\pi-workspace\\记忆\\人格定义.json'), true);
  assert.equal(isProtectedPath('/home/u/pi-workspace/记忆/人格定义.json'), true);
  assert.equal(isProtectedPath('D:\\pi-workspace\\记忆\\记忆日志.md'), false);
  assert.equal(isCanonicalTarget('D:\\pi-workspace\\记忆\\人格定义.json', { wsRoot: 'D:\\pi-workspace' }), true);
  assert.equal(isCanonicalTarget('D:\\pi-workspace\\记忆\\记忆日志.md', { wsRoot: 'D:\\pi-workspace' }), false);
});

test('字段级核对：定义里声明的每一项都必须在人格段里落地（年龄/称呼/语气/价值观/边界/禁忌/裁决）', () => {
  const def = { ...DEFAULT_DEFINITION, name: '小语', age: 20, tone: ['只说重点'], taboos: ['不说套话'] };
  const okAudit = auditPersona(def);
  assert.equal(okAudit.ok, true, JSON.stringify(okAudit.missing));
  // 有人把渲染器改坏（比如漏掉禁忌）→ 逐字段核对必须报出来
  const broken = auditPersona(def, '【人格】我是小语，20 岁的 AI 工作伙伴。');
  assert.equal(broken.ok, false);
  assert.ok(broken.missing.includes('tone') && broken.missing.includes('taboos'), JSON.stringify(broken.missing));
  assert.ok(broken.missing.includes('authority'), '没有身份裁决也算没落地');
});
