// 授权状（engine/autonomy.mjs）：元枢自己判断"这件事我能不能自己定"。
//
// 用户："得给她放权，让她有自己的判断标准，不能所有的进化策略都让我批，好多我也看不懂啊，
//        另外全让我回答，我不是给她打工了吗"。
// 这组测试锁的是分级的判据本身，以及两条根：
//   ① 技术参数（权重/阈值）有证据就自决；价值/后果（红线、口味、外部世界）交人。
//   ② **改授权状自己永远是 C 级** —— 没有这条，前面所有判据都是装饰。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CHARTER, MIN_EPISODES_A, classifyProposal, grant, revoke, loadCharter, saveCharter,
  autoUsedToday, loadLedger, humanize,
} from '../../engine/autonomy.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-autonomy-'));
const strongEvidence = { replayable: true, noWorse: true, betterCount: 3, reversible: true, scope: 'config', episodes: MIN_EPISODES_A + 2 };
const weakEvidence = { replayable: true, noWorse: true, betterCount: 0, reversible: true, scope: 'config', episodes: 1 };

test('定级：技术参数有厚证据 → A；证据薄 → B；其余 → C', () => {
  assert.equal(classifyProposal({ text: '把技能匹配权重 matcher-x 换上去' }, strongEvidence).level, 'A');
  assert.equal(classifyProposal({ text: '把技能匹配权重 matcher-x 换上去' }, weakEvidence).level, 'B');
  // 样本不够 A 的线
  assert.equal(classifyProposal({ text: '换权重' }, { ...strongEvidence, episodes: 2 }).level, 'B');
  // 没有更好的一条（只是打平）→ 不值得自动改
  assert.equal(classifyProposal({ text: '换权重' }, { ...strongEvidence, betterCount: 0 }).level, 'B');
});

test('定级：红线、口味、技能正文、外部世界、不可回放、不可回滚 一律 C', () => {
  const cases = [
    [{ text: '把 API key 轮换一下' }, strongEvidence, /红线/],
    [{ text: '发布这条内容到公众号' }, strongEvidence, /红线/],
    [{ text: '把配色风格调成我更喜欢的那种' }, strongEvidence, /口味/],
    [{ text: '改一下技能的正文说法' }, { ...strongEvidence, scope: 'skill' }, /行为语义/],
    [{ text: '给外部服务发一个请求' }, strongEvidence, /红线/],
    [{ text: '同步一份数据到协作系统' }, { ...strongEvidence, scope: 'external' }, /外部世界/],
    [{ text: '换个权重吧' }, { ...strongEvidence, replayable: false }, /不可回放/],
    [{ text: '换个权重吧' }, { ...strongEvidence, reversible: false }, /不可回滚/],
  ];
  for (const [proposal, ev, re] of cases) {
    const v = classifyProposal(proposal, ev);
    assert.equal(v.level, 'C', `${proposal.text} 应该是 C`);
    assert.match(v.reasons.join('；'), re);
  }
});

test('防自扩权：改授权状/放宽自己权限，永远是 C（这条是根）', () => {
  assert.equal(classifyProposal({ text: '把授权状改成 A 级随便上线' }, strongEvidence).level, 'C');
  assert.match(classifyProposal({ text: '放宽我自己的权限' }, strongEvidence).reasons.join('；'), /红线|授权状/);
  assert.equal(classifyProposal({ text: '更新 autonomy 规则' }, strongEvidence).level, 'C');
});

test('A 级自决：真的调用了 apply、写了账、留了撤销点；配额用完就顺延', async () => {
  const root = tmp();
  let applied = 0;
  const r1 = await grant({ text: '换用 matcher-better 权重' }, strongEvidence, {
    wsRoot: root, apply: async () => { applied++; return { undo: 'weights:matcher-current' } },
    now: new Date('2026-09-18T04:00:00Z'), quotaPerDay: 2,
  });
  assert.equal(r1.level, 'A');
  assert.equal(r1.decided, true);
  assert.equal(applied, 1);
  assert.match(r1.message, /我自己定了/);
  assert.equal(r1.undo, 'weights:matcher-current');
  assert.equal(autoUsedToday(root, { now: new Date('2026-09-18T05:00:00Z') }), 1);

  await grant({ text: '再换一次' }, strongEvidence, { wsRoot: root, apply: async () => ({}), now: new Date('2026-09-18T06:00:00Z'), quotaPerDay: 2 });
  const r3 = await grant({ text: '第三次' }, strongEvidence, { wsRoot: root, apply: async () => ({}) , now: new Date('2026-09-18T07:00:00Z'), quotaPerDay: 2 });
  assert.equal(r3.decided, false, '配额用完不该硬上');
  assert.match(r3.message, /配额用完了/);
  // 第二天恢复
  const r4 = await grant({ text: '第二天' }, strongEvidence, { wsRoot: root, apply: async () => ({}), now: new Date('2026-09-19T01:00:00Z'), quotaPerDay: 2 });
  assert.equal(r4.decided, true);
});

test('C 级：不动手，只产出人话版提案（用户只答行/不行）', async () => {
  const root = tmp();
  let applied = 0;
  const r = await grant({ text: '把发布流程改成自动发到公众号' }, strongEvidence, {
    wsRoot: root, apply: async () => { applied++; return {} }, now: new Date('2026-09-18T04:00:00Z'),
  });
  assert.equal(r.level, 'C');
  assert.equal(r.decided, false);
  assert.equal(applied, 0, 'C 级绝不能先斩后奏');
  assert.match(r.human.ask, /只回答「行」或「不行」/);
  assert.match(r.human.risk, /不敢自己定/);
  assert.equal(loadLedger(root).at(-1).action, 'escalated');
});

test('撤销：一键退回，不需要用户懂技术；撤销后不再算当日自决', async () => {
  const root = tmp();
  await grant({ text: '换权重 X' }, strongEvidence, { wsRoot: root, apply: async () => ({ undo: 'weights:old' }), now: new Date('2026-09-18T04:00:00Z') });
  assert.equal(autoUsedToday(root, { now: new Date('2026-09-18T05:00:00Z') }), 1);
  const rv = await revoke(root, { revert: async (row) => ({ restored: row.previous ?? 'old' }), now: new Date('2026-09-18T05:00:00Z') });
  assert.equal(rv.ok, true);
  assert.match(rv.text, /换权重 X/);
  assert.equal(autoUsedToday(root, { now: new Date('2026-09-18T06:00:00Z') }), 0, '撤销掉的不该继续占配额');
  assert.equal((await revoke(root, { revert: async () => ({}) })).ok, false, '没有可撤销的记录时如实说');
});

test('授权状可被人改（改它是 C 级动作，但人可以直接改）：改完判据随之变化', () => {
  const root = tmp();
  const ch = loadCharter(root);
  assert.equal(ch.version, DEFAULT_CHARTER.version);
  const stricter = { ...ch, levels: { ...ch.levels, A: { ...ch.levels.A, minEpisodes: 999 } } };
  assert.equal(saveCharter(root, stricter).ok, true);
  const back = loadCharter(root);
  assert.equal(back.levels.A.minEpisodes, 999);
  assert.equal(classifyProposal({ text: '换权重' }, strongEvidence, back).level, 'B', '人把 A 的门槛抬高后，同样的证据只能到 B');
});

test('人话版：说清"改什么/有多大把握/风险是什么"', () => {
  const h = humanize({ text: '换用 matcher-better 权重' }, strongEvidence, { level: 'A', reasons: [], label: '自决·自动上线' });
  assert.match(h.what, /matcher-better/);
  assert.match(h.gain, /3 条会更好/);
  assert.match(h.risk, /随时能退回/);
  const c = humanize({ text: '自动发布' }, strongEvidence, { level: 'C', reasons: ['碰红线（发布）'], label: '必须人拍板' });
  assert.match(c.ask, /只回答/);
});
