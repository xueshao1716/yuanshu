// 重复检测的契约：这条规则是从一份**真剧本**（别的工具自动生成的 10 集）里长出来的。
// 那份剧本第 5 集与第 6 集逐字相同、26% 的段落跨集重复，而当时没有任何环节报警。
import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatCheck } from '../../engine/story/craft.mjs';
import { lintStoryProject } from '../../engine/story/lint.mjs';

const ep = (no, body) => ({ no, title: `第${no}集`, text: body });

test('整集逐字重复必须报（真机样本：第 5 集 = 第 6 集）', () => {
  const body = '林默跪在站台地面，双手抱头。\n陈曦：你的意识会彻底消散。你会死。\n系统面板：终止协议未满足。';
  const r = repeatCheck([ep(5, body), ep(6, body)]);
  const hit = r.issues.find(i => i.code === 'repeat-unit');
  assert.ok(hit, '整集逐字相同必须报 repeat-unit');
  assert.equal(hit.a, 5);
  assert.equal(hit.b, 6);
  assert.ok(hit.overlap >= 99, `重合度要接近 100%，实际 ${hit.overlap}`);
  assert.equal(r.level, 'warn');
});

test('段落跨集重复要报，并给出占比（真机样本约 26%）', () => {
  const shared = '【场景】夜，城市边缘站台。高空冷风卷着细碎的霓虹光屑掠过站台边缘。';
  const units = [
    ep(1, `${shared}\n林默推开铁门，铁锈簌簌落下，他侧身挤了出去。`),
    ep(2, `${shared}\n陈曦看着面板，区域稳定性正在跳水。`),
    ep(3, `${shared}\n系统面板弹出红色的强制净化警告。`),
  ];
  const r = repeatCheck(units);
  const hit = r.issues.find(i => i.code === 'repeat-paragraph');
  assert.ok(hit, '同一段话出现在 3 集里必须报 repeat-paragraph');
  assert.equal(r.stats.duplicatedParagraphs, 1);
  assert.equal(r.stats.duplicatedOccurrences, 3);
  assert.ok(r.stats.ratio > 0.2, `占比要能算出来，实际 ${r.stats.ratio}`);
});

test('正常剧本不许误报（各集各自推进 = 干净）', () => {
  const r = repeatCheck([
    ep(1, '林默在发霉的地下室醒来，系统面板弹出红色警告。\n林默：这是哪……'),
    ep(2, '清晨的城市街区空无一人，行人机械地重复着同一条路线。\n林默：他们不是在走路，他们是在被播放。'),
    ep(3, '废弃站台上，陈曦第一次出现在阴影里，指尖划过空气泛起涟漪。\n陈曦：你挡住了我的视线。'),
  ]);
  assert.deepEqual(r.issues, [], `不该报任何重复，实际：${r.issues.map(i => i.code).join('、')}`);
  assert.equal(r.stats.duplicatedParagraphs, 0);
  assert.equal(r.level, 'ok');
});

test('太短的单元不参与比对（一句话的场次不算"重复"）', () => {
  const r = repeatCheck([ep(1, '门开了。'), ep(2, '门开了。')]);
  assert.deepEqual(r.issues, []);
});

test('体检把它接上：项目里两场正文雷同 → repeat- 开头的 warn', () => {
  const beat = { dialogue: '林默：我不可能……为什么这些记忆会出现在我脑子里？', prompt: '林默跪在站台地面，双手抱头，系统面板剧烈抖动。' };
  const project = {
    logline: '一句话',
    bible: { characters: [{ name: '林默', appearance: '工程服', refImage: 'a.png' }] },
    scenes: [
      { title: '边缘站台A', summary: '代价被说破', beats: [{ ...beat }] },
      { title: '边缘站台B', summary: '代价被说破', beats: [{ ...beat }] },
    ],
  };
  const lint = lintStoryProject(project);
  assert.ok(lint.issues.some(i => i.code.startsWith('repeat-')), `体检必须报出重复，实际：${lint.issues.map(i => i.code).join('、')}`);
  assert.ok(lint.summary.repeatParagraphs >= 1);
});
