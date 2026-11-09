// 教训复习（2026-11-09）：从"只记账"到"隔几天想起来一次"。
// 锁的是行为边界：选谁、多久算到期、一天最多几条、复习后复现怎么升级；不是文案。
// 阈值（7/14/30 天、一天 2 条、复习后 7 天内复现）改之前先来改这里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LESSON_LEDGER, loadLessonLedger, promoteReflectionLessons, lessonDraft, buildLessonProposal,
  REPLAY_RECURRENCE_DAYS,
} from '../../engine/lesson-promotion.mjs';
import {
  REPLAY_STATE_REL, REPLAY_LOG_REL, PROMPT_PREFIX, SPACING_DAYS, DAY_MS,
  lessonId, importanceOf, selectDueLessons, markReplayed, dueNote, ymdOf,
  readReplayState, replayPromptLine,
} from '../../engine/lesson-replay.mjs';

const NOW = new Date(2026, 10, 9, 9, 0, 0); // 本地 2026-11-09 09:00，跨时区都指向同一天
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY_MS);
const agoIso = (n) => daysAgo(n).toISOString();

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-replay-'));
const ledgerFile = (root) => path.join(root, LESSON_LEDGER);
const stateFile = (root) => path.join(root, REPLAY_STATE_REL);
const logFile = (root) => path.join(root, REPLAY_LOG_REL);

function writeLedger(root, lessons) {
  fs.mkdirSync(path.dirname(ledgerFile(root)), { recursive: true });
  fs.writeFileSync(ledgerFile(root), JSON.stringify({ lessons, promoted: [] }, null, 2), 'utf8');
}
function logLines(root) {
  return fs.readFileSync(logFile(root), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const lesson = (over = {}) => ({
  text: '写中文文件后要 grep 一遍 U+FFFD 再交付',
  topic: '编码',
  ymd: '2026-09-01',
  at: '2026-09-01T10:00:00.000Z',
  ...over,
});
const block = (lessons) => '复盘正文……\n```json\n' + JSON.stringify({ actions: [{ text: '把某事做掉并核对', kind: 'fix' }], lessons }) + '\n```';

// ── 选择 ───────────────────────────────────────────────────────────────

test('选择：从未复习的优先 → 久未复习的次之 → 同久时 importance 高的先', () => {
  const never = lesson({ text: '从没复习过的老教训', topic: 'A', importance: 'low', ymd: '2026-09-01' });
  const old = lesson({ text: '很久没复习的高优', topic: 'B', importance: 'medium', replayCount: 1, lastReplayed: agoIso(40) });
  const recent = lesson({ text: '刚复习过一阵的中优', topic: 'C', importance: 'high', replayCount: 1, lastReplayed: agoIso(20) });
  const sameOldLow = lesson({ text: '同一天复习但优先级低', topic: 'D', importance: 'low', replayCount: 2, lastReplayed: agoIso(40) });
  const due = selectDueLessons({ lessons: [recent, sameOldLow, old, never], now: NOW, maxPerDay: 10 });
  assert.deepEqual(due.map((l) => l.topic), ['A', 'B', 'D', 'C'],
    '未复习的 A 第一；40 天前的 B/D 在 20 天前的 C 前面；B/D 同久时 medium > low');
});

test('选择：没写 importance 时按同主题在账本里出现次数推断（≥3 高 / 2 中 / 1 低）', () => {
  assert.equal(importanceOf(lesson({ importance: 'high' })), 'high', '写了就听写的');
  assert.equal(importanceOf(lesson({ importance: '乱写' })), 'medium', '非法值回落 medium');
  const counts = new Map([['完成判据', 4], ['挂账清算', 2], ['子智能体', 1]]);
  assert.equal(importanceOf(lesson({ topic: '完成判据' }), counts), 'high');
  assert.equal(importanceOf(lesson({ topic: '挂账清算' }), counts), 'medium');
  assert.equal(importanceOf(lesson({ topic: '子智能体' }), counts), 'low');
  assert.equal(importanceOf(lesson({ topic: '没出现过' }), counts), 'low');
  assert.equal(importanceOf(lesson({ topic: '没出现过' })), 'medium', '没传计数就按默认档');
});

test('间隔：high 7 天 / medium 14 天 / low 30 天，差一天不算到期', () => {
  assert.deepEqual({ ...SPACING_DAYS }, { high: 7, medium: 14, low: 30 });
  const dueAt = (importance, n) => selectDueLessons({
    lessons: [lesson({ importance, replayCount: 1, lastReplayed: agoIso(n) })],
    now: NOW,
  }).length;
  for (const [importance, gap] of [['high', 7], ['medium', 14], ['low', 30]]) {
    assert.equal(dueAt(importance, gap - 1), 0, `${importance} ${gap - 1} 天不该到期`);
    assert.equal(dueAt(importance, gap), 1, `${importance} ${gap} 天该到期`);
  }
});

test('间隔：从没复习过的按入库时间起算，昨天写的不催、上个月写的到期', () => {
  const fresh = lesson({ text: '昨天刚写的教训', topic: 'F', ymd: '2026-11-08', at: daysAgo(1).toISOString(), importance: 'medium' });
  assert.equal(selectDueLessons({ lessons: [fresh], now: NOW }).length, 0);
  const stale = lesson({ text: '上个月写的教训', topic: 'G', ymd: '2026-10-01', at: daysAgo(39).toISOString(), importance: 'medium' });
  assert.equal(selectDueLessons({ lessons: [stale], now: NOW }).length, 1);
  assert.equal(selectDueLessons({ lessons: [lesson({ topic: 'H', replayCount: 0, lastReplayed: agoIso(90) })], now: NOW }).length, 1,
    '有 lastReplayed 但计数为 0 也按"没复习过"起算，不催刚写下的');
});

test('每日上限 2 条；同一主题同一天只出一条（不在一段话里说两遍同样的话）', () => {
  const many = [
    lesson({ text: '完成判据一', topic: '完成判据', importance: 'high', ymd: '2026-09-01' }),
    lesson({ text: '完成判据二', topic: '完成判据', importance: 'high', ymd: '2026-09-02' }),
    lesson({ text: '挂账清算一', topic: '挂账清算', importance: 'high', ymd: '2026-09-03' }),
    lesson({ text: '真机实测一', topic: '真机实测', importance: 'high', ymd: '2026-09-04' }),
  ];
  const due = selectDueLessons({ lessons: many, now: NOW });
  assert.equal(due.length, 2, '默认一天最多 2 条');
  assert.equal(new Set(due.map((l) => l.topic)).size, 2, '两条不能是同一个主题');
  assert.deepEqual(due.map((l) => l.topic), ['完成判据', '挂账清算']);
  assert.equal(selectDueLessons({ lessons: many, now: NOW, maxPerDay: 0 }).length, 0);
});

// ── 文案 ───────────────────────────────────────────────────────────────

test('dueNote：一行一条，带第几次回看和上次日期；从没复习过就说首次', () => {
  const replayed = lesson({
    text: '完成判据要跑命令再说话',
    replayCount: 2,
    lastReplayed: new Date(2026, 10, 2, 20, 0, 0).toISOString(),
  });
  assert.equal(dueNote(replayed), '复习：完成判据要跑命令再说话（第 3 次回看，上次 11-02）');
  assert.equal(dueNote(lesson({ text: '从没复习过的一条', replayCount: 0 })), '复习：从没复习过的一条（第 1 次回看，首次复习）');
  assert.ok(dueNote(lesson({ text: '带\n换行的   一条教训' })).includes('带 换行的 一条教训'), '压成一行');
  assert.ok(dueNote(lesson({ text: 'x'.repeat(200) })).length <= 90, '太长截断，别把 system 块撑爆');
});

test('dueNote：复习后仍复现的，文案后面追一句', () => {
  const l = lesson({ text: '完成判据要跑命令再说话', replayCount: 1, lastReplayed: agoIso(9), replayEscalated: true });
  assert.match(dueNote(l), /（复习后仍复现，已升级）$/);
});

// ── 记账 ───────────────────────────────────────────────────────────────

test('markReplayed：计数 +1、时间写回、复习记录 jsonl 落盘', () => {
  const root = tmp();
  const l = lesson({});
  writeLedger(root, [l]);
  const id = lessonId(l);
  assert.match(id, /^L-[0-9a-f]{10}$/, 'id 由 ymd+at+正文算，账本里没有 id 字段也能定位');

  const r = markReplayed(root, [id], { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.updated.length, 1);
  const led = loadLessonLedger(root);
  assert.equal(led.lessons[0].replayCount, 1);
  assert.equal(led.lessons[0].lastReplayed, NOW.toISOString());
  assert.equal(led.lessons[0].text, l.text, '正文原样不动');

  markReplayed(root, [id], { now: new Date(NOW.getTime() + 60000) });
  assert.equal(loadLessonLedger(root).lessons[0].replayCount, 2);
  const lines = logLines(root);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, id);
  assert.equal(lines[0].replayCount, 1);
  assert.equal(lines[1].replayCount, 2);
  assert.equal(lines[1].topic, '编码');
});

test('markReplayed：给了不存在的 id 只报 missing，不写坏账本', () => {
  const root = tmp();
  writeLedger(root, [lesson({})]);
  const before = fs.readFileSync(ledgerFile(root), 'utf8');
  const r = markReplayed(root, ['L-0000000000'], { now: NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['L-0000000000']);
  assert.equal(fs.readFileSync(ledgerFile(root), 'utf8'), before);
});

test('markReplayed：账本缺失/坏掉都不抛错，也不覆盖坏文件', () => {
  const empty = tmp();
  assert.doesNotThrow(() => markReplayed(empty, ['L-0000000000'], { now: NOW }));
  assert.equal(markReplayed(empty, ['L-0000000000'], { now: NOW }).ok, false);

  const broken = tmp();
  fs.mkdirSync(path.dirname(ledgerFile(broken)), { recursive: true });
  fs.writeFileSync(ledgerFile(broken), '{ 这不是 JSON', 'utf8');
  let r;
  assert.doesNotThrow(() => { r = markReplayed(broken, ['L-0000000000'], { now: NOW }); });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(ledgerFile(broken), 'utf8'), '{ 这不是 JSON', '坏账本不许被静默重建');
});

// ── 注入 ───────────────────────────────────────────────────────────────

test('注入：每天只一次；注入即记账（计数/时间/jsonl/状态文件都对得上）', () => {
  const root = tmp();
  const old = lesson({ text: '上个月的教训', topic: 'A', ymd: '2026-09-01', at: agoIso(69) });
  writeLedger(root, [old]);

  const line = replayPromptLine({ root, now: NOW, history: [] });
  assert.equal(line, '复习：上个月的教训（第 1 次回看，首次复习）');
  assert.ok(line.startsWith(PROMPT_PREFIX));

  const led = loadLessonLedger(root);
  assert.equal(led.lessons[0].replayCount, 1);
  assert.equal(led.lessons[0].lastReplayed, NOW.toISOString());
  assert.equal(logLines(root).length, 1);
  const st = readReplayState(root);
  assert.equal(st.lastInjectedDate, ymdOf(NOW));
  assert.equal(st.lastIds.length, 1);

  assert.equal(replayPromptLine({ root, now: NOW, history: [] }), '', '同一天再进对话不再念');
  assert.equal(loadLessonLedger(root).lessons[0].replayCount, 1, '没注入就不许记账');
});

test('注入：第二天再进对话会换下一批', () => {
  const root = tmp();
  writeLedger(root, [
    lesson({ text: '上个月的教训一', topic: 'A', at: agoIso(69) }),
    lesson({ text: '上个月的教训二', topic: 'B', at: agoIso(68) }),
    lesson({ text: '上个月的教训三', topic: 'C', at: agoIso(67) }),
  ]);
  assert.match(replayPromptLine({ root, now: NOW, history: [] }), /教训一/);
  const nextDay = new Date(NOW.getTime() + DAY_MS);
  const second = replayPromptLine({ root, now: nextDay, history: [] });
  assert.match(second, /教训三/, '昨天复习过的两条 7~30 天内不再到期，只剩没复习的那条');
  assert.equal(readReplayState(root).lastInjectedDate, ymdOf(nextDay));
});

test('注入：昨天念过的主题今天先让开（不连着两天说同一件事）', () => {
  const root = tmp();
  writeLedger(root, [
    lesson({ text: '教训X1', topic: 'X', at: agoIso(70) }),
    lesson({ text: '教训X2', topic: 'X', at: agoIso(69) }),
    lesson({ text: '教训X3', topic: 'X', at: agoIso(68) }),
    lesson({ text: '教训Y1', topic: 'Y', at: agoIso(67) }),
    lesson({ text: '教训Y2', topic: 'Y', at: agoIso(66) }),
    lesson({ text: '教训Z1', topic: 'Z', at: agoIso(65) }),
    lesson({ text: '教训W1', topic: 'W', at: agoIso(64) }),
  ]);
  const day1 = replayPromptLine({ root, now: NOW, history: [] });
  assert.match(day1, /教训X1/);
  assert.match(day1, /教训Y1/);
  assert.deepEqual(readReplayState(root).lastTopics, ['X', 'Y']);
  const day2 = replayPromptLine({ root, now: new Date(NOW.getTime() + DAY_MS), history: [] });
  assert.doesNotMatch(day2, /教训X|教训Y/, '昨天念过的主题今天不念，哪怕还有同主题的旧条目没复习过');
  assert.match(day2, /教训Z1/);
  assert.match(day2, /教训W1/);
  assert.deepEqual(readReplayState(root).lastTopics, ['Z', 'W']);
});

test('注入：除了昨天那两个主题就没别的了 → 仍然补上，不因避让整天不念', () => {
  const root = tmp();
  writeLedger(root, [
    lesson({ text: '教训X1', topic: 'X', at: agoIso(70) }),
    lesson({ text: '教训X2', topic: 'X', at: agoIso(69) }),
  ]);
  assert.match(replayPromptLine({ root, now: NOW, history: [] }), /教训X1/);
  const day2 = replayPromptLine({ root, now: new Date(NOW.getTime() + DAY_MS), history: [] });
  assert.match(day2, /教训X2/, '只有这一个主题到期时，避让要让步（宁可用同主题，也别一整天不念）');
});

test('注入：没有到期条目就零注入，不写状态也不写记录', () => {
  const root = tmp();
  writeLedger(root, [lesson({ text: '昨天刚写的', ymd: '2026-11-08', at: agoIso(1), importance: 'medium' })]);
  assert.equal(replayPromptLine({ root, now: NOW, history: [] }), '');
  assert.equal(fs.existsSync(stateFile(root)), false);
  assert.equal(fs.existsSync(logFile(root)), false);

  const noLedger = tmp();
  assert.equal(replayPromptLine({ root: noLedger, now: NOW, history: [] }), '');
  assert.equal(fs.existsSync(stateFile(noLedger)), false);
});

test('注入：历史里已经有「复习：」就跳过，且不记账', () => {
  const root = tmp();
  writeLedger(root, [lesson({ text: '上个月的教训', at: agoIso(69) })]);
  const history = [{ role: 'system', content: '复习：上次已经注入过的东西' }, { role: 'user', content: '在吗' }];
  assert.equal(replayPromptLine({ root, now: NOW, history }), '');
  assert.equal(loadLessonLedger(root).lessons[0].replayCount, undefined);
  assert.equal(fs.existsSync(stateFile(root)), false);
});

test('注入：账本坏掉时降级为零注入，不抛错', () => {
  const root = tmp();
  fs.mkdirSync(path.dirname(ledgerFile(root)), { recursive: true });
  fs.writeFileSync(ledgerFile(root), 'not json at all', 'utf8');
  let line = 'x';
  assert.doesNotThrow(() => { line = replayPromptLine({ root, now: NOW, history: [] }); });
  assert.equal(line, '');
});

// ── 与复现检测联动 ─────────────────────────────────────────────────────

const reviewed = (over = {}) => lesson({
  text: '完成判据要跑一遍命令再说已修复',
  topic: '完成判据',
  ymd: '2026-10-20',
  at: '2026-10-20T10:00:00.000Z',
  replayCount: 1,
  lastReplayed: new Date(2026, 10, 3, 20, 0, 0).toISOString(),
  ...over,
});
const recurringTonight = () => block([{ text: '完成判据还是没跑命令就说话了', topic: '完成判据' }]);

test('复习后 7 天内又复现 → 提案优先级升一档，并给那条教训打标', () => {
  const root = tmp();
  writeLedger(root, [reviewed(), lesson({ text: '别的话', topic: '别的', ymd: '2026-10-21' })]);
  const calls = [];
  const r = promoteReflectionLessons(root, recurringTonight(), {
    ymd: '2026-11-05',
    now: new Date(2026, 10, 5, 10, 0, 0), // 距上次复习 2 天，在 7 天窗口内
    propose: (c) => { calls.push(c); return { ok: true, id: 'p1' }; },
  });
  assert.equal(r.proposed.length, 1);
  assert.equal(calls[0].replayEscalated, true);
  assert.equal(calls[0].priority, 'high', '默认 medium 升一档到 high');
  assert.equal(calls[0].replayWindowDays, REPLAY_RECURRENCE_DAYS);

  const led = loadLessonLedger(root);
  const hit = led.lessons.find((l) => l.text.startsWith('完成判据要跑一遍命令'));
  assert.equal(hit.replayEscalated, true, '打标落在被复习的那条上');
  assert.ok(hit.replayEscalatedAt);
  assert.match(dueNote(hit), /（复习后仍复现，已升级）$/);
});

test('复习后超过 7 天才复现 → 不升级；复习前就复现的也不算', () => {
  const late = tmp();
  writeLedger(late, [reviewed({ lastReplayed: new Date(2026, 9, 20, 10, 0, 0).toISOString() })]);
  const lateCalls = [];
  promoteReflectionLessons(late, recurringTonight(), {
    ymd: '2026-11-05', now: new Date(2026, 10, 5, 10, 0, 0),
    propose: (c) => { lateCalls.push(c); return { ok: true, id: 'p1' }; },
  });
  assert.equal(lateCalls.length, 1);
  assert.equal(lateCalls[0].replayEscalated, undefined);
  assert.equal(lateCalls[0].priority, 'medium');
  assert.equal(buildLessonProposal(lateCalls[0], '2026-11-06').priority, '', '没升级的提案不带 priority，池子照旧按时间排');
  const hit = loadLessonLedger(late).lessons.find((l) => l.text.startsWith('完成判据要跑一遍命令'));
  assert.equal(hit.replayEscalated, undefined);
});

test('升级后的提案：正文带出处、带进提案池的 priority 字段', async () => {
  const root = tmp();
  writeLedger(root, [reviewed()]);
  const calls = [];
  promoteReflectionLessons(root, recurringTonight(), {
    ymd: '2026-11-05', now: new Date(2026, 10, 5, 10, 0, 0),
    propose: (c) => { calls.push(c); return { ok: true, id: 'p1' }; },
  });
  const payload = buildLessonProposal(calls[0], '2026-11-06');
  assert.match(payload.draft, /复习后仍复现，已升级/);
  assert.equal(payload.priority, 'high');
  assert.equal(payload.topic, '完成判据');

  const { initEvolutionApi, proposeLessonPromotion, listMemoryNudges } = await import('../../engine/evolution-api.mjs');
  initEvolutionApi({ root, prompts: root, skills: root });
  const p = proposeLessonPromotion(payload);
  assert.equal(p.ok, true);
  const n = listMemoryNudges().find((x) => x.id === p.id);
  assert.equal(n.priority, 'high');
  assert.match(n.draft, /复习后仍复现，已升级/);
});

test('接线：yuanshu-emotion 把复习接进同一块 system，emotion.init 绑工作区根，server 只调一个入口', () => {
  const read = (...p) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', ...p), 'utf8');
  const src = read('engine', 'yuanshu-emotion.mjs');
  assert.match(src, /import \{ replayPromptLine \} from "\.\/lesson-replay\.mjs"/);
  // 复习行仍在反模式之后、同一 system 块里；中间可插别的行（2026-11-09 插了正向账本），顺序约束不变。
  assert.match(src, /antiPatternLine\(msg, context\)[\s\S]{0,200}?replayLine\(history\)/, '和反模式同一块，顺序在反模式之后');
  assert.match(src, /const already = alreadyInjected\(history\)/, '先判去重，再取有落盘副作用的复习行');
  const emo = read('engine', 'emotion.mjs');
  assert.match(emo, /initLessonReplay\(wsRoot\)/);
  assert.match(read('server.mjs'), /proposeLessonPromotion\(buildLessonProposal\(c, today\)\)/);
});

test('lessonDraft：没升级的老格式原样不动（不破坏经验库既有出处写法）', () => {
  const c = { text: '中文落盘后要扫一遍替换字符', topic: '编码', days: ['2026-10-05', '2026-10-06'] };
  assert.equal(lessonDraft(c, '2026-10-07'),
    '- [2026-10-07] [编码] 中文落盘后要扫一遍替换字符（晋升：复盘 2 天复现；来源：2026-10-05、2026-10-06）');
});
