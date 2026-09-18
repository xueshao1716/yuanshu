// 做梦（engine/dream.mjs）：拿历史当模拟器，离线评估"要不要改"。
//
// 用户："openclaw、hermes 都有做梦，我觉得这是个重要方向"。
// 第一片可做梦的搜索空间是**技能匹配器的权重表**——输入是当时的任务句、真值是当时真的
// activate 了哪个技能，两者都躺在历史里，所以回放是精确的、零真实执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEpisodes, loadEpisodes, replayPolicy, dream, writeDreamLog, skillEpisodesFromSessions, dreamPaths } from '../../engine/dream.mjs';
import { MATCH_WEIGHTS, matchSkillsForTask } from '../../engine/yuanshu-protocol.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-dream-'));

test('episode 存取：同一任务句合并成一条（真值取并集）、按 kind 过滤、坏行不炸', () => {
  const root = tmp();
  appendEpisodes(root, [
    { kind: 'skill-match', input: '画个海报', choice: 'wanxiang-design' },
    { kind: 'skill-match', input: '画个海报', choice: 'gpt-image-2' },      // 同句的第二个技能 → 并入真值
    { kind: 'skill-match', input: '画个海报', choice: 'wanxiang-design' },  // 完全重复
    { kind: 'other', input: 'x', choice: 'y' },
    null,
  ]);
  fs.appendFileSync(dreamPaths(root).episodes, '{坏行\n', 'utf8');
  const all = loadEpisodes(root);
  assert.equal(all.length, 2, '同句合并、重复去掉、坏行跳过');
  const poster = loadEpisodes(root, { kind: 'skill-match' })[0];
  assert.deepEqual(poster.choices, ['wanxiang-design', 'gpt-image-2'], '真值是并集');
  assert.equal(loadEpisodes(root, { kind: 'other' }).length, 1);
});

test('回放：命中真值 1 分、进前三 0.5 分、否则 0 分（真值是一组，不是一个）', () => {
  const eps = [
    { kind: 'k', input: 'a', choice: 'X' },
    { kind: 'k', input: 'b', choice: 'Y' },
    { kind: 'k', input: 'c', choice: 'Z' },
    { kind: 'k', input: 'd', choices: ['P', 'Q'] },   // 同一句话当时连开了两个技能
  ];
  const rank = (ep) => ({ a: ['X', 'p', 'q'], b: ['p', 'Y', 'q'], c: ['p', 'q', 'r'], d: ['Q', 'x'] }[ep.input]);
  const r = replayPolicy({ id: 'p1' }, eps, { rank });
  assert.equal(r.episodes, 4);
  assert.equal(r.total, 2.5);
  assert.equal(r.rows[2].score, 0, '连前三都没进就是 0 分');
  assert.equal(r.rows[3].score, 1, '真值是一组时，排第一的是组里任何一个都算命中');
});

test('做梦：赢家不可能更差（现役在候选里，且有更差的一条就不换）', () => {
  const eps = [
    { kind: 'skill-match', input: 'a', choice: 'X' },
    { kind: 'skill-match', input: 'b', choice: 'Y' },
    { kind: 'skill-match', input: 'c', choice: 'Z' },
  ];
  const rank = (ep, policy) => {
    const table = {
      incumbent: { a: ['X', 'p', 'q'], b: ['p', 'q', 'r'], c: ['p', 'q', 'r'] },   // 1 + 0 + 0 = 1
      better: { a: ['X', 'p', 'q'], b: ['p', 'Y', 'q'], c: ['p', 'q', 'r'] },      // 1 + 0.5 + 0 = 1.5，每条都不更差
      mixed: { a: ['p', 'q', 'X'], b: ['Y', 'p', 'q'], c: ['Z', 'p', 'q'] },       // 三个 0.5 = 1.5（平均更高）
    };
    return table[policy.id]?.[ep.input] || [];
  };
  const r = dream({
    kind: 'skill-match', episodes: eps, incumbentId: 'incumbent',
    candidates: [{ id: 'better' }, { id: 'mixed' }], rank,
  });
  assert.equal(r.ok, true);
  const byId = Object.fromEntries(r.table.map((t) => [t.id, t]));
  assert.equal(byId.incumbent.decision, 'keep');
  assert.equal(byId.better.decision, 'promote');
  assert.equal(byId.mixed.decision, 'reject', '平均分一样高，但每条都从 1 掉到 0.5 —— 不许换');
  assert.match(byId.mixed.reason, /更差/);
  assert.equal(r.winner, 'better');
  assert.match(r.proposal.text, /每条都不更差/);
});

test('做梦：没有历史就老实说没得做；没给现役直接拒绝；候选漏了现役也会被强制补上', () => {
  const noHist = dream({ kind: 'k', episodes: [], incumbentId: 'a', candidates: [{ id: 'b' }], rank: () => [] });
  assert.equal(noHist.ok, false);
  assert.match(noHist.reason, /没有历史/);
  const noIncumbent = dream({ kind: 'k', episodes: [{ input: 'x', choice: 'y' }], incumbentId: '', candidates: [{ id: 'b' }], rank: () => [] });
  assert.equal(noIncumbent.ok, false);
  assert.match(noIncumbent.reason, /必须给出现役策略 id/);
  // 候选里没写现役 → 引擎自己补进回放表（这条性质由构造保证，不靠调用方自觉）
  const forced = dream({ kind: 'k', episodes: [{ input: 'x', choice: 'y' }], incumbentId: 'inc', candidates: [{ id: 'cand' }], rank: (ep, p) => (p.id === 'inc' ? ['y'] : ['z']) });
  assert.equal(forced.ok, true);
  assert.deepEqual(forced.table.map((t) => t.id).sort(), ['cand', 'inc']);
});

test('做梦真的跑在元枢的技能匹配器上：现役权重 vs 候选权重，回放真实历史句', () => {
  const skills = [
    { name: 'aigc-video-production', desc: '短视频脚本与分镜' },
    { name: 'wanxiang-design', desc: '海报与平面设计出图' },
    { name: 'daily-retrospective', desc: '当用户要求复盘某天或某个项目时用：全景表、归因、沉淀' },
  ];
  // 历史真值：当时 agent 真的 activate 了哪个（这里用现役匹配器的结果当"历史"，形状与真机一致）
  const inputs = ['帮我写个爆款短视频脚本', '给我画一张国风海报', '今天复盘一下'];
  const episodes = inputs.map((m) => ({ kind: 'skill-match', input: m, choice: matchSkillsForTask(m, skills)[0].name }));
  const rank = (ep, policy) => matchSkillsForTask(ep.input, skills, 3, policy.weights).map((s) => s.name);
  const r = dream({
    kind: 'skill-match', episodes, incumbentId: 'matcher-current',
    candidates: [
      { id: 'matcher-domainx2', weights: { ...MATCH_WEIGHTS, video: 8, image: 6, ppt: 8, novel: 6 } },
      { id: 'matcher-nameonly', weights: { ...MATCH_WEIGHTS, descToken: 0, video: 0, image: 0, ppt: 0, novel: 0 } },
    ],
    rank,
  });
  assert.equal(r.ok, true);
  assert.equal(r.episodes, 3);
  assert.equal(r.table[0].id, 'matcher-current');
  assert.equal(r.table[0].accuracy, 1, '现役在自己的历史上当然是满分（这是回放的第一条自检）');
  const nameonly = r.table.find((t) => t.id === 'matcher-nameonly');
  assert.equal(nameonly.decision, 'reject', '把域加分全砍掉必须被判更差（否则说明回放没在真回放）');
  assert.ok(nameonly.worse > 0);
});

test('做梦要留痕：日志里能看出回放了多少条、谁赢了、为什么', () => {
  const root = tmp();
  const eps = [{ kind: 'k', input: 'a', choice: 'X' }];
  const r = dream({ kind: 'k', episodes: eps, incumbentId: 'inc', candidates: [{ id: 'cand' }], rank: (ep, p) => (p.id === 'inc' ? ['X'] : ['Y']) });
  writeDreamLog(root, 'k', r, { now: new Date('2026-09-18T04:00:00Z') });
  const log = fs.readFileSync(dreamPaths(root).log, 'utf8');
  assert.match(log, /做梦：k/);
  assert.match(log, /回放历史 1 条/);
  assert.match(log, /\[reject\] cand/);
  assert.match(log, /保持不变/);
});

test('从会话文件里挖历史决策：同一句话激活多个技能要合并成一条（真值是一组）', () => {
  const lines = [
    JSON.stringify({ type: 'custom_message', message: { role: 'user', content: [{ text: '【元枢内置技能库】…' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-09-16T12:00:00Z', message: { role: 'user', content: [{ text: '帮我画一张水墨黄河图' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-09-16T12:00:05Z', message: { role: 'toolResult', toolName: 'activate_skill', content: [{ text: '技能 image-generation 已加载（0.4KB）' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-09-16T12:00:06Z', message: { role: 'toolResult', toolName: 'activate_skill', content: [{ text: '技能 gpt-image-2 已加载（0.3KB）' }] } }),
  ].join('\n');
  const eps = skillEpisodesFromSessions(['/fake/s.jsonl'], { readFile: () => lines });
  assert.equal(eps.length, 1, '同一个任务句只留一条');
  assert.deepEqual(eps[0].choices, ['image-generation', 'gpt-image-2']);
  assert.equal(eps[0].choice, 'image-generation');
  assert.equal(eps[0].input, '帮我画一张水墨黄河图');
});
