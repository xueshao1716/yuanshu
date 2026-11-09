// 正向账本（2026-11-10）：只锁行为边界——记什么、不记什么、怎么合并/淘汰、注入多少、
// 失衡时怎么让位。文案（鼓励式收尾）只锁关键那半句，不锁措辞。
// 阈值（合并 0.9 / 上限 200 / 一天 1 条 / 负向 3 倍）改之前先来改这里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LEDGER_REL, STATE_REL, HIT_REL, FAILURE_REL, PROMPT_PREFIX, MAX_ENTRIES, MERGE_THRESHOLD, DAY_MS,
  recordPositive, recordFromTurn, judgePraise, similarity, stats, praisePromptLine,
} from '../../engine/praise-ledger.mjs';
import { replayPromptLine } from '../../engine/lesson-replay.mjs';
import { LESSON_LEDGER } from '../../engine/lesson-promotion.mjs';

const NOW = new Date(2026, 10, 10, 9, 0, 0); // 本地 2026-11-10 09:00，跨时区都指向同一天
const daysAgo = (n) => NOW.getTime() - n * DAY_MS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'praise-ledger-'));
const ledgerFile = (root) => path.join(root, LEDGER_REL);
const stateFile = (root) => path.join(root, STATE_REL);
const hitFile = (root) => path.join(root, HIT_REL);
const failFile = (root) => path.join(root, FAILURE_REL);
const readItems = (root) => JSON.parse(fs.readFileSync(ledgerFile(root), 'utf8')).items;

// 负向证据：反模式命中（每次一行，at 是 ISO）+ 失败台账（items[].at 是毫秒）
function writeHits(root, times = []) {
  fs.mkdirSync(path.dirname(hitFile(root)), { recursive: true });
  const text = times
    .map((ms, i) => JSON.stringify({ id: 'AP-001', evidence: `编造事实 ${i}`, at: new Date(ms).toISOString() }))
    .join('\n') + '\n';
  fs.writeFileSync(hitFile(root), text, 'utf8');
}
function writeFailures(root, times = []) {
  fs.mkdirSync(path.dirname(failFile(root)), { recursive: true });
  const items = times.map((ms, i) => ({ id: `f-${i}`, at: ms, attempt: `试了第 ${i} 条路`, why: '走不通' }));
  fs.writeFileSync(failFile(root), JSON.stringify({ v: 1, items }, null, 2), 'utf8');
}
function writeLessons(root, lessons = []) {
  const file = path.join(root, LESSON_LEDGER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ lessons, promoted: [] }, null, 2), 'utf8');
}

const ONE_LESSON = {
  text: '写中文文件后要 grep 一遍 U+FFFD 再交付',
  topic: '编码',
  importance: 'high',
  ymd: '2026-09-01',
  at: '2026-09-01T10:00:00.000Z',
};

test('记一条要过三道门：字段齐全、必须有证据、不许泛泛', () => {
  const root = tmp();
  const r = recordPositive({
    wsRoot: root, kind: 'completed', scene: '交付前自查',
    what: '交付前把三条验证都跑了一遍并贴了结果', why: '不是自己说做成了',
    evidence: '交付门 GREEN · 3 个文件', at: NOW,
  });
  assert.equal(r.ok, true);
  const [e] = readItems(root);
  for (const k of ['id', 'at', 'kind', 'scene', 'what', 'why', 'evidence', 'weight', 'source']) {
    assert.ok(k in e, `条目缺字段 ${k}`);
  }
  assert.equal(e.kind, 'completed');
  assert.equal(e.weight, 1);
  assert.equal(e.at, NOW.getTime());

  // 没证据 → 不记（红线 ①）
  const noEvidence = recordPositive({ wsRoot: root, kind: 'praise', what: '挂账清算时主动列了三条欠账', evidence: '' });
  assert.equal(noEvidence.ok, false);
  assert.match(noEvidence.error, /证据/);

  // 泛泛 → 不记（红线 ②：「她很棒」只有 3 个字）
  const vague = recordPositive({ wsRoot: root, kind: 'praise', what: '她很棒', evidence: '用户说谢谢' });
  assert.equal(vague.ok, false);
  assert.match(vague.error, /泛/);

  // 两条都被挡在门外，账本没被写脏
  assert.equal(readItems(root).length, 1);
});

test('同一个 what 相似 ≥0.9 合并：只出 weight+1，不新增条目', () => {
  const root = tmp();
  const base = {
    wsRoot: root, kind: 'praise', scene: '挂账清算',
    what: '挂账清算时主动列了三条欠账', evidence: '用户原话：「谢谢你，这次列得清楚」',
  };
  assert.equal(recordPositive({ ...base, at: NOW }).ok, true);
  assert.equal(recordPositive({ ...base, at: new Date(NOW.getTime() + 2000) }).ok, true);

  const items = readItems(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].weight, 2);
  assert.equal(items[0].merges, 1);
  assert.equal(similarity(base.what, base.what), 1);
  assert.ok(similarity(base.what, '把交付门的验证全部跑过') < MERGE_THRESHOLD);
});

test('上限淘汰：按 weight 留，轻的、旧的先走', () => {
  const root = tmp();
  const rows = [
    ['挂账清算时主动列了三条欠账', 3],
    ['交付前把中文文件的乱码又查了一遍', 1],
    ['用户说卡住时先给结论再解释', 1],
    ['重试失败的命令换了个参数一次跑通', 1],
  ];
  for (const [what, weight] of rows) {
    const r = recordPositive({ wsRoot: root, kind: 'completed', what, evidence: `证据：${what}`, weight, maxEntries: 3, at: NOW });
    assert.equal(r.ok, true, r.error);
  }
  const items = readItems(root);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((x) => x.weight).sort(), [1, 1, 3]);
  assert.ok(items.some((x) => x.what === '挂账清算时主动列了三条欠账'), 'weight 高的被淘汰了');
  assert.equal(MAX_ENTRIES, 200);
});

test('四类判定①：用户明确道谢才算 praise，含糊/转折/没场景都不记', () => {
  const root = tmp();
  const ok = recordFromTurn({
    wsRoot: root, userText: '谢谢你，这次挂账清算你主动列了三条欠账',
    scene: '挂账清算时主动列了三条欠账', at: NOW,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.recorded[0].entry.kind, 'praise');
  assert.match(ok.recorded[0].entry.evidence, /用户原话/);

  // 「还行吧」这种不算表扬
  assert.equal(judgePraise('还行吧').praise, false);
  assert.equal(recordFromTurn({ wsRoot: root, userText: '还行吧', scene: '挂账清算', at: NOW }).ok, false);

  // 带转折 → 不记（「谢谢你，但是还是不对」不是表扬）
  assert.equal(judgePraise('谢谢你，但是还是不对').praise, false);

  // 只有一句「谢谢」、没说是哪件事 → 不记（夸的是啥都说不清 = 无凭据）
  const noScene = recordFromTurn({ wsRoot: root, userText: '谢谢你', at: NOW });
  assert.equal(noScene.ok, false);
  assert.ok(noScene.skipped.some((s) => s.kind === 'praise'));

  assert.equal(readItems(root).length, 1);
});

test('四类判定②：交付门 GREEN 且无回滚才算 completed', () => {
  const root = tmp();
  const green = recordFromTurn({
    wsRoot: root,
    gate: { verdict: 'GREEN', files: ['engine/praise-ledger.mjs'], reasons: ['改动都有验证覆盖'], runId: 'r-1' },
    at: NOW,
  });
  assert.equal(green.ok, true);
  assert.equal(green.recorded[0].entry.kind, 'completed');
  assert.match(green.recorded[0].entry.evidence, /GREEN/);

  // 红/黄 不算做成
  for (const verdict of ['RED', 'YELLOW']) {
    const r = recordFromTurn({ wsRoot: root, gate: { verdict, summary: '没过' }, at: NOW });
    assert.equal(r.ok, false, `${verdict} 被记成了做成`);
  }
  // 裸「GREEN」也说不出交付了什么 → 不记
  assert.equal(recordFromTurn({ wsRoot: root, gate: 'GREEN', at: NOW }).ok, false);
  // 有回滚 → 不记
  assert.equal(recordFromTurn({ wsRoot: root, gate: { verdict: 'GREEN', summary: '改了两处', rollback: true }, at: NOW }).ok, false);

  assert.equal(readItems(root).length, 1);
});

test('四类判定③：失败过、且明确重试成功才算 recovered', () => {
  const root = tmp();
  const ok = recordFromTurn({ wsRoot: root, retry: { failed: true, succeeded: true, attempts: 2, error: 'ENOENT' }, at: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.recorded[0].entry.kind, 'recovered');
  assert.match(ok.recorded[0].entry.evidence, /重试成功/);

  assert.equal(recordFromTurn({ wsRoot: root, retry: { failed: true, succeeded: false }, at: NOW }).ok, false);
  assert.equal(recordFromTurn({ wsRoot: root, retry: { succeeded: true }, at: NOW }).ok, false, '没失败过不算恢复');
  assert.equal(readItems(root).length, 1);
});

test('四类判定④：主动提醒明确被采纳才算 handled_well', () => {
  const root = tmp();
  const ok = recordFromTurn({ wsRoot: root, followUp: { reminder: '交付前先查一遍中文乱码', adopted: true, after: '照做了' }, at: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.recorded[0].entry.kind, 'handled_well');

  assert.equal(recordFromTurn({ wsRoot: root, followUp: { reminder: '交付前先查一遍中文乱码', adopted: false }, at: NOW }).ok, false);
  assert.equal(readItems(root).length, 1);
});

test('注入：空账本零注入；有记录才有；一天只念一条', () => {
  const empty = tmp();
  assert.equal(praisePromptLine({ wsRoot: empty, now: NOW }), '');
  assert.equal(fs.existsSync(stateFile(empty)), false, '零注入不该留下状态文件');
  assert.equal(fs.existsSync(ledgerFile(empty)), false);

  const root = tmp();
  recordPositive({ wsRoot: root, kind: 'completed', what: '挂账清算时主动列了三条欠账', evidence: '用户原话：「列得清楚」', at: NOW });
  const line = praisePromptLine({ wsRoot: root, now: NOW });
  assert.ok(line.startsWith(PROMPT_PREFIX), line);
  assert.match(line, /挂账清算时主动列了三条欠账/);

  // 同一天再进来 → 空（一天只念一次）
  assert.equal(praisePromptLine({ wsRoot: root, now: NOW }), '');

  // 第二天 → 又能念一条
  const tomorrow = new Date(NOW.getTime() + DAY_MS);
  assert.ok(praisePromptLine({ wsRoot: root, now: tomorrow }).startsWith(PROMPT_PREFIX));

  // 这段对话历史里已经念过 → 不再念
  const day3 = new Date(tomorrow.getTime() + DAY_MS);
  assert.equal(praisePromptLine({ wsRoot: root, now: day3, history: [{ role: 'system', content: line }] }), '');

  // 注入次数记在条目上（两次真注入）
  assert.equal(readItems(root)[0].injectedCount, 2);
});

test('「做对过：」和「复习：」各有各的额度，互不挤占', () => {
  const root = tmp();
  writeLessons(root, [ONE_LESSON]);
  recordPositive({ wsRoot: root, kind: 'praise', what: '挂账清算时主动列了三条欠账', evidence: '用户原话：「列得清楚」', at: NOW });

  const praise = praisePromptLine({ wsRoot: root, now: NOW });
  const replay = replayPromptLine({ root, now: NOW });
  assert.ok(praise.startsWith(PROMPT_PREFIX), praise);
  assert.ok(replay.startsWith('复习：'), replay);

  // 反过来：先念过复习，做对过照样能念（两个状态文件互不覆盖）
  const root2 = tmp();
  writeLessons(root2, [ONE_LESSON]);
  const replay2 = replayPromptLine({ root: root2, now: NOW });
  assert.ok(replay2.startsWith('复习：'), replay2);
  recordPositive({ wsRoot: root2, kind: 'praise', what: '挂账清算时主动列了三条欠账', evidence: '用户原话：「列得清楚」', at: NOW });
  assert.ok(praisePromptLine({ wsRoot: root2, now: NOW }).startsWith(PROMPT_PREFIX));
});

test('比例：7 天负向 ≥ 3 倍正向就标失衡，注入换鼓励式文案', () => {
  // 3 条反模式命中、0 条正向 → 失衡；空账本仍然零注入
  const root = tmp();
  writeHits(root, [daysAgo(0.1), daysAgo(1), daysAgo(2)]);
  const s0 = stats({ wsRoot: root, days: 7, now: NOW });
  assert.equal(s0.positive, 0);
  assert.equal(s0.negative, 3);
  assert.equal(s0.ratio, 0);
  assert.equal(s0.imbalanced, true);
  assert.equal(s0.skipAntiPattern, true);
  assert.equal(praisePromptLine({ wsRoot: root, now: NOW }), '');

  // 失败台账也算负向；窗口外的老账不算
  writeFailures(root, [daysAgo(1), daysAgo(2), daysAgo(30)]);
  const s1 = stats({ wsRoot: root, days: 7, now: NOW });
  assert.equal(s1.negative, 5);
  assert.equal(s1.negativeHits, 3);
  assert.equal(s1.negativeFailures, 2);

  // 补一条正向（1 : 5 仍失衡）→ 文案带鼓励收尾
  recordPositive({ wsRoot: root, kind: 'completed', what: '挂账清算时主动列了三条欠账', evidence: '交付门 GREEN · 3 个文件', at: NOW });
  const line = praisePromptLine({ wsRoot: root, now: NOW });
  assert.match(line, /别把「全都错了」当成结论/);

  // 负向 2、正向 1 → 不到 3 倍，不算失衡
  const quiet = tmp();
  writeHits(quiet, [daysAgo(1), daysAgo(2)]);
  recordPositive({ wsRoot: quiet, kind: 'completed', what: '重试失败的命令换了个参数一次跑通', evidence: '先失败 2 次，重试成功', at: NOW });
  const s2 = stats({ wsRoot: quiet, days: 7, now: NOW });
  assert.equal(s2.positive, 1);
  assert.equal(s2.negative, 2);
  assert.equal(s2.ratio, 0.5);
  assert.equal(s2.imbalanced, false);
});
