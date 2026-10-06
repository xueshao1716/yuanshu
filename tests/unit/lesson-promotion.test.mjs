// 复盘教训晋升（2026-10-07）：跨日复现才提案，只提案不写，提过的不再提
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReflectionLessons, lessonSimilarity, findRecurringLessons, promoteReflectionLessons, lessonDraft, loadLessonLedger } from '../../engine/lesson-promotion.mjs';
import { buildTimeTaskPrompt } from '../../engine/time-task-run.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-'));
const block = (lessons) => '复盘正文……\n```json\n' + JSON.stringify({ actions: [{ text: '把某事做掉并核对', kind: 'fix' }], lessons }) + '\n```';

test('解析：取最后一个 JSON 块的 lessons；字符串也收；太短/缺省给空', () => {
  assert.deepEqual(parseReflectionLessons(block([{ text: '改源码前先确认后台测试跑完', topic: '测试纪律' }, '说已验证之前必须真跑过命令', { text: '短' }])),
    [{ text: '改源码前先确认后台测试跑完', topic: '测试纪律' }, { text: '说已验证之前必须真跑过命令', topic: '' }]);
  assert.deepEqual(parseReflectionLessons('```json\n{"actions":[]}\n```'), []);
  assert.deepEqual(parseReflectionLessons('没有 JSON'), []);
});

test('相似度：topic 相同直接算复现；不同 topic 看字二元组', () => {
  assert.equal(lessonSimilarity({ text: 'a 完全不同的话', topic: '编码' }, { text: '另一句毫不相干', topic: '编码' }), 1);
  assert.ok(lessonSimilarity({ text: '中文写文件后要 grep 一遍 U+FFFD' }, { text: '写中文文件后 grep 一遍 U+FFFD 再交付' }) >= 0.34);
  assert.ok(lessonSimilarity({ text: '中文写文件后要 grep 一遍 U+FFFD' }, { text: '先问伙伴再改界面布局' }) < 0.2);
});

test('复现：只认别的日子；同一天写两遍不算；提过的不再提', () => {
  const ledger = { lessons: [{ text: '诊断前先全量 git grep，别只搜一个目录', topic: '诊断', ymd: '2026-10-05' }, { text: '先看失败会话属于哪个入口', topic: '入口', ymd: '2026-10-06' }], promoted: [] };
  const r = findRecurringLessons(ledger, [{ text: '下结论前全量搜调用点', topic: '诊断' }, { text: '先看失败会话属于哪个入口再查链路', topic: '入口' }], '2026-10-06');
  assert.equal(r.length, 1, '入口那条只在今天出现过（同日不算）');
  assert.equal(r[0].topic, '诊断');
  assert.deepEqual(r[0].days, ['2026-10-05', '2026-10-06']);
  assert.equal(findRecurringLessons({ ...ledger, promoted: [{ text: 'x', topic: '诊断' }] }, [{ text: '下结论前全量搜调用点', topic: '诊断' }], '2026-10-06').length, 0);
});

test('端到端：第一晚只落账；第二晚复现 → 出提案（带来源日期），并记已提；提案失败不记', () => {
  const ws = tmp();
  const calls = [];
  const propose = (c) => { calls.push(c); return { ok: true, id: 'p1' }; };
  const n1 = promoteReflectionLessons(ws, block([{ text: '写中文后 grep U+FFFD', topic: '编码' }]), { ymd: '2026-10-05', propose });
  assert.deepEqual([n1.recorded, n1.proposed.length, calls.length], [1, 0, 0]);
  const n2 = promoteReflectionLessons(ws, block([{ text: '中文落盘后要扫一遍替换字符', topic: '编码' }]), { ymd: '2026-10-06', propose });
  assert.equal(n2.proposed.length, 1);
  assert.deepEqual(calls[0].days, ['2026-10-05', '2026-10-06']);
  const draft = lessonDraft(calls[0], '2026-10-07');
  assert.match(draft, /^- \[2026-10-07\] \[编码\] 中文落盘后要扫一遍替换字符（晋升：复盘 2 天复现；来源：2026-10-05、2026-10-06）$/);
  const led = loadLessonLedger(ws);
  assert.equal(led.lessons.length, 2);
  assert.equal(led.promoted.length, 1);
  // 第三晚同主题：已提过，不再骚扰
  const n3 = promoteReflectionLessons(ws, block([{ text: '编码又出事了', topic: '编码' }]), { ymd: '2026-10-07', propose });
  assert.equal(n3.proposed.length, 0);
  // 提案被池子拒（skip/error）就不记已提，下次还能提
  const ws2 = tmp();
  promoteReflectionLessons(ws2, block([{ text: '一条教训一条教训', topic: 'T' }]), { ymd: '2026-10-01', propose: () => ({ skip: true }) });
  const r = promoteReflectionLessons(ws2, block([{ text: '一条教训一条教训', topic: 'T' }]), { ymd: '2026-10-02', propose: () => ({ skip: true }) });
  assert.equal(r.proposed.length, 0);
  assert.equal(loadLessonLedger(ws2).promoted.length, 0);
});

test('复盘 prompt 要求 lessons 字段，并说明只提案', () => {
  const p = buildTimeTaskPrompt({ prompt: '复盘' }, { ymd: '2026-10-06' });
  assert.match(p, /"lessons":\[\{"text"/);
  assert.match(p, /伙伴点头才写/);
});

test('已有主题词喂回复盘：近的在前、去重；prompt 要求沿用原词', async () => {
  const { recentLessonTopics } = await import('../../engine/lesson-promotion.mjs');
  const ws = tmp();
  const propose = () => ({ skip: true });
  promoteReflectionLessons(ws, block([{ text: '写中文后 grep U+FFFD', topic: '编码' }, { text: '先问伙伴再改界面布局', topic: '界面' }]), { ymd: '2026-10-05', propose });
  promoteReflectionLessons(ws, block([{ text: '下结论前全量搜调用点', topic: '诊断' }, { text: '中文落盘要扫替换字符', topic: '编码 ' }]), { ymd: '2026-10-06', propose });
  assert.deepEqual(recentLessonTopics(ws), ['编码', '诊断', '界面']);
  const p = buildTimeTaskPrompt({ prompt: '复盘' }, { ymd: '2026-10-06', lessonTopics: ['编码', '诊断'] });
  assert.match(p, /已有教训主题词.*沿用原词.*：编码、诊断/);
  assert.doesNotMatch(buildTimeTaskPrompt({ prompt: '复盘' }, { ymd: '2026-10-06' }), /已有教训主题词/);
});
