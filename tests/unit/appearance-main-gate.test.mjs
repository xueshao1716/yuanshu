// 硬边界（2026-11-08）：**主形象设定读取失败时禁用辅**（记忆/外观.md）
//
// 背景：人格定义读失败会回退 DEFAULT_DEFINITION（四项空），以前这时 外观.md 会顶上 primary，
// 于是"及肩深色短发 + 深色连帽衫"就成了她的正式外观。要求是宁可没有外貌，也不要这套。
// 判据只看 loadPersonaDefinition 的 source / problems：
//   · source !== "file"（文件缺失 / JSON 读坏）→ 主不可用
//   · problems 非空（校验不过）              → 主不可用
// 三处调用（出图母提示词 / 画个你 / 自我.md）必须走同一个 mergeAppearanceWithPersona。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appearanceMainGate, appearanceAuxFor, mergeAppearanceWithPersona,
} from '../../engine/appearance-merge.mjs';
import { loadPersonaDefinition } from '../../engine/persona-def.mjs';
import { buildIdentityPrompt, planAppearanceInjection, COMPANION_IDENTITY_PROMPT_NO_LOOK } from '../../engine/companion-appearance.mjs';
import { buildSelfModel, renderSelfMarkdown } from '../../engine/self-model.mjs';
import { buildSelfPortraitPrompt } from '../../engine/persona-look.mjs';

const MAIN = {
  appearance: '20 岁上下的中国女生，皮肤白净偏冷调，眼睛偏大而清亮。',
  hairstyle: '齐耳短发，深棕近黑，发尾自然内扣。',
  clothing: '修身短款灰色针织上衣，高腰黑色直筒短裤。',
  scenarioOutfits: '工作：针织上衣袖子推到肘部。',
};

const AUX = [
  '及肩深色短发，发梢泛星空蓝光',
  '眼睛温暖明亮，笑起来有一点弯',
  '深色连帽衫，领口一枚发光圆形徽章',
  '整体安静温暖，赛博朋克 × 治愈系，高质量插画，柔和光晕',
];

// 辅独有的字眼：任何一条出现在输出里，都说明"主失败禁用辅"被绕过了
const AUX_NEEDLES = ['及肩', '星空蓝', '连帽衫', '发光圆形徽章', '柔和光晕', '赛博朋克', '补充）'];

const EMPTY_PRIMARY = { appearance: '', hairstyle: '', clothing: '', scenarioOutfits: '' };

function assertNoAux(text, where) {
  for (const needle of AUX_NEEDLES) {
    assert.equal(String(text).includes(needle), false, `${where} 出现了辅的内容：${needle}`);
  }
}

function workspace(t, { persona } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-gate-'));
  fs.mkdirSync(path.join(root, '记忆'), { recursive: true });
  fs.writeFileSync(path.join(root, '记忆', '外观.md'), `<!-- 辅 -->\n${AUX.join('\n')}\n`, 'utf8');
  if (persona !== undefined) fs.writeFileSync(path.join(root, '记忆', '人格定义.json'), persona, 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const validPersona = (over = {}) => JSON.stringify({
  version: 1, name: '小语', age: 20, gender: '女性', called: '伙伴', bond: '知己',
  inner: ['我有自己的判断'], boundaries: ['人格只读'], growth: '批准后演化。',
  ...MAIN, ...over,
});

test('判据来自 loadPersonaDefinition：JSON 读坏 = source default + problems 非空', (t) => {
  const root = workspace(t, { persona: '{ "name": "小语", ' }); // 故意写坏
  const pd = loadPersonaDefinition(root);
  assert.equal(pd.source, 'default');
  assert.ok(pd.problems.some((p) => p.includes('读取失败')), '读失败要能在 problems 里认出来');

  const gate = appearanceMainGate(root);
  assert.equal(gate.disabled, true);
  assert.equal(gate.reason, 'read-failed');
  assert.deepEqual(appearanceAuxFor(root).aux, [], '主读失败时辅必须为空');
});

test('主读失败：三处输出都不含 外观.md 任何内容、primary 为空、有明确标记', (t) => {
  const root = workspace(t, { persona: '{ "name": "小语", ' });
  const def = loadPersonaDefinition(root).def;

  // ① 合并结果：primary 为空、无补充、text 为空、带标记
  const merged = mergeAppearanceWithPersona({ wsRoot: root, def });
  assert.deepEqual(merged.primary, EMPTY_PRIMARY);
  assert.deepEqual(merged.supplements, []);
  assert.equal(merged.text, '');
  assert.equal(merged.auxDisabled, true);
  assert.equal(merged.auxDisabledReason, 'read-failed');

  // ② 自我.md：不写辅，留诊断标记
  const model = buildSelfModel({ wsRoot: root });
  assert.deepEqual(model.design, EMPTY_PRIMARY);
  assert.deepEqual(model.appearanceSupplements, []);
  assert.equal(model.appearanceAuxDisabled, true);
  assert.equal(model.appearanceAuxDisabledReason, 'read-failed');
  const md = renderSelfMarkdown(model);
  assertNoAux(md, '自我.md');
  assert.match(md, /（诊断）补充外观已禁用/);
  assert.match(md, /记忆\/人格定义\.json` 读取失败/);

  // ③ 出图母提示词：退回"无外貌"版本，且 meta 能看出禁用
  const meta = {};
  const prompt = buildIdentityPrompt(def, { wsRoot: root, meta });
  assert.equal(prompt, COMPANION_IDENTITY_PROMPT_NO_LOOK);
  assertNoAux(prompt, '出图母提示词');
  assert.equal(meta.auxDisabled, true);
  assert.equal(meta.auxDisabledReason, 'read-failed');

  // ④ 画个你：不用 FALLBACK_LOOK（那套和辅是同一身），也没有辅的内容
  const diagnostics = {};
  const look = buildSelfPortraitPrompt({ wsRoot: root, seed: 7, diagnostics });
  assertNoAux(look, '画个你');
  assert.equal(look.includes('及肩的深色短发'), false, '不该用 FALLBACK_LOOK 顶上');
  assert.equal(diagnostics.auxDisabled, true);
  assert.equal(diagnostics.auxDisabledReason, 'read-failed');
  assert.match(look, /【小语自画像】/, '身份/场景骨架仍要在');

  // ⑤ 聊天注入计划也带上标记，排查时不用翻日志
  const plan = planAppearanceInjection('你长什么样', def, { wsRoot: root });
  assert.equal(plan.auxDisabled, true);
  assert.equal(plan.auxDisabledReason, 'read-failed');
  assertNoAux(plan.full, '聊天完整块');
});

test('主文件缺失也算主不可用（reason=missing），而不是让辅顶上', (t) => {
  const root = workspace(t); // 没有 人格定义.json
  const gate = appearanceMainGate(root);
  assert.equal(gate.disabled, true);
  assert.equal(gate.reason, 'missing');

  const model = buildSelfModel({ wsRoot: root });
  assert.equal(model.appearanceAuxDisabled, true);
  assert.deepEqual(model.design, EMPTY_PRIMARY);
  assertNoAux(renderSelfMarkdown(model), '自我.md');

  const prompt = buildIdentityPrompt({}, { wsRoot: root });
  assert.equal(prompt, COMPANION_IDENTITY_PROMPT_NO_LOOK);
  assertNoAux(prompt, '出图母提示词');
});

test('主校验不过（problems 非空）也禁用辅：主外貌保留，辅一个字都不收', (t) => {
  const root = workspace(t, { persona: validPersona({ age: 200 }) }); // age 越界 → problems
  const pd = loadPersonaDefinition(root);
  assert.equal(pd.source, 'file');
  assert.ok(pd.problems.length > 0);

  const merged = mergeAppearanceWithPersona({ wsRoot: root, def: pd.def });
  assert.equal(merged.auxDisabled, true);
  assert.equal(merged.auxDisabledReason, 'invalid');
  assert.equal(merged.primary.appearance, MAIN.appearance, '主写了的项照常生效');
  assert.deepEqual(merged.supplements, []);
  assertNoAux(merged.text, '合并文本');

  const model = buildSelfModel({ wsRoot: root });
  const md = renderSelfMarkdown(model);
  assert.ok(md.includes(MAIN.appearance), '主外貌不能因为 problems 被丢掉');
  assertNoAux(md, '自我.md');
  assert.match(md, /（诊断）补充外观已禁用/);

  const identity = buildIdentityPrompt(pd.def, { wsRoot: root });
  assert.ok(identity.includes(MAIN.appearance));
  assertNoAux(identity, '出图母提示词');
});

test('主正常但某项为空：辅仍可补该项（硬边界不误伤）', (t) => {
  const root = workspace(t, { persona: validPersona({ hairstyle: '' }) });
  const pd = loadPersonaDefinition(root);
  assert.equal(pd.problems.length, 0);

  const merged = mergeAppearanceWithPersona({ wsRoot: root, def: pd.def });
  assert.equal(merged.auxDisabled, false);
  assert.equal(merged.sources.hairstyle, 'aux');
  assert.ok(merged.primary.hairstyle.includes('及肩深色短发'));
  assert.ok(merged.primary.hairstyle.includes('发梢泛星空蓝光'));
  // 主有的项仍是主的；辅的细节补在后面
  assert.equal(merged.primary.appearance, MAIN.appearance);
  // 2026-11-08 口径：徽章算服装冲突，不再作为补充；改验证主没写的神态细节，冲突项在 dropped 留痕。
  assert.ok(merged.supplements.some((s) => s.text === '眼睛温暖明亮'));
  assert.ok(merged.dropped.some((d) => d.reason === 'conflict' && d.text === '领口一枚发光圆形徽章'));

  const model = buildSelfModel({ wsRoot: root });
  assert.equal(model.appearanceAuxDisabled, false);
  const md = renderSelfMarkdown(model);
  assert.ok(md.includes('发梢泛星空蓝光')); // 主缺发型 → 辅整项顶上，仍是正文
  assert.ok(md.includes('- （补充）眼睛温暖明亮'));

  const identity = buildIdentityPrompt(pd.def, { wsRoot: root });
  assert.ok(identity.includes('发梢泛星空蓝光'));
  assert.ok(identity.includes('（补自 记忆/外观.md）'), '主缺的项由辅顶上时要标来源');
});

test('显式传 aux 也绕不过：只要给了 wsRoot 且主不可用，aux 一律作废', (t) => {
  const root = workspace(t, { persona: '{ bad json' });
  const meta = {};
  const prompt = buildIdentityPrompt({}, { wsRoot: root, aux: AUX, meta });
  assert.equal(prompt, COMPANION_IDENTITY_PROMPT_NO_LOOK);
  assertNoAux(prompt, '显式 aux');
  assert.equal(meta.auxDisabled, true);

  // 没给 wsRoot 时无从判断主，保留旧行为（调用方显式 aux 照用，reason=unchecked）
  const noRoot = mergeAppearanceWithPersona({ def: MAIN, aux: AUX });
  assert.equal(noRoot.auxDisabled, false);
  assert.equal(noRoot.auxDisabledReason, 'unchecked');
  // 2026-11-08 口径：染发算冲突，不再作为补充；用神态细节 + 画风补充证明 aux 仍被照用。
  assert.ok(noRoot.supplements.some((s) => s.text === '眼睛温暖明亮'));
  assert.ok(noRoot.supplements.some((s) => s.kind === 'style' && s.text.includes('赛博朋克')));
  assert.match(noRoot.text, /补充细节（来自 记忆\/外观\.md/);
});
