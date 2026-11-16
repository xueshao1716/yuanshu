import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectDayMessages, writeDayDigest, maybeWriteDigests, parseDayRefs, dayDigestNote, digestPath,
} from '../../engine/day-digest.mjs';

const msg = (ts, role, text) => JSON.stringify({ type: 'message', timestamp: ts, message: { role, content: [{ type: 'text', text }] } });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  const file = path.join(root, 's1.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id: 's1' }),
    msg('2026-11-07T15:00:00.000Z', 'user', '这条是 11-07 深夜（本地已是 11-08）'),
    msg('2026-11-08T02:00:00.000Z', 'user', '帮我修慢请求日志停记的问题'),
    msg('2026-11-08T02:01:00.000Z', 'assistant', '好的，已经改成轮转'),
    msg('2026-11-09T02:00:00.000Z', 'user', '第二天的话'),
  ].join('\n'));
  return { root, sessions: [{ id: 's1', name: '修日志', file }] };
}
const localDay = iso => new Date(iso).toLocaleDateString('sv-SE');

test('微信桥拼的环境说明不进摘要，只留【对方消息】后面的话', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  const file = path.join(root, 'wx.jsonl');
  fs.writeFileSync(file, msg('2026-11-08T02:00:00.000Z', 'user', '【微信环境·必读】回复短、口语。\n\n【对方消息】\n发张工作台截图'));
  try {
    const groups = await collectDayMessages([{ id: 'wx', file }], localDay('2026-11-08T02:00:00.000Z'));
    assert.equal(groups[0].items[0].text, '发张工作台截图');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('collectDayMessages 按本地日期取当天的用户/助手消息', async () => {
  const { root, sessions } = fixture();
  try {
    const day = localDay('2026-11-08T02:00:00.000Z');
    const groups = await collectDayMessages(sessions, day);
    const texts = groups.flatMap(g => g.items.map(i => i.text));
    assert.ok(texts.includes('帮我修慢请求日志停记的问题'));
    assert.ok(!texts.includes('第二天的话'));
    assert.equal(groups[0].name, '修日志');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('writeDayDigest：模型可用时写模型摘要，已存在就跳过', async () => {
  const { root, sessions } = fixture();
  try {
    const day = localDay('2026-11-08T02:00:00.000Z');
    const r = await writeDayDigest(root, { date: day, sessions, summarize: async () => '- 修了慢请求日志' });
    assert.equal(r.skipped, false);
    assert.match(fs.readFileSync(digestPath(root, day), 'utf8'), /修了慢请求日志/);
    const again = await writeDayDigest(root, { date: day, sessions, summarize: async () => 'x' });
    assert.equal(again.skipped, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('writeDayDigest：模型失败退回规则摘要（列用户原话）；没消息的日子不写', async () => {
  const { root, sessions } = fixture();
  try {
    const day = localDay('2026-11-08T02:00:00.000Z');
    const r = await writeDayDigest(root, { date: day, sessions, summarize: async () => { throw new Error('down'); } });
    assert.equal(r.fallback, true);
    assert.match(fs.readFileSync(digestPath(root, day), 'utf8'), /修日志[\s\S]*帮我修慢请求日志/);
    const empty = await writeDayDigest(root, { date: '2026-01-01', sessions, summarize: null });
    assert.equal(empty.reason, 'no_data');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('maybeWriteDigests 只补过去的日子，不写今天', async () => {
  const { root, sessions } = fixture();
  try {
    const now = new Date('2026-11-09T04:00:00.000Z');
    const done = await maybeWriteDigests(root, { now, sessions, summarize: null, backfill: 3 });
    const dates = done.map(d => d.date);
    assert.ok(dates.includes(localDay('2026-11-08T02:00:00.000Z')));
    assert.ok(!dates.includes(localDay(now)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('parseDayRefs 认昨天/前天/具体日期，不乱认', () => {
  const now = new Date(2026, 10, 15, 10);
  assert.deepEqual(parseDayRefs('昨天聊了什么', now), ['2026-11-14']);
  assert.deepEqual(parseDayRefs('前天那个问题', now), ['2026-11-13']);
  assert.deepEqual(parseDayRefs('11月8日做了啥', now), ['2026-11-08']);
  assert.deepEqual(parseDayRefs('看下 11-08 和 2026-10-16', now).sort(), ['2026-10-16', '2026-11-08']);
  assert.deepEqual(parseDayRefs('12月20号', now), ['2025-12-20']);
  assert.deepEqual(parseDayRefs('帮我改个按钮', now), []);
});

test('dayDigestNote 提到日期且有摘要时才给出', async () => {
  const { root, sessions } = fixture();
  try {
    const day = localDay('2026-11-08T02:00:00.000Z');
    await writeDayDigest(root, { date: day, sessions, summarize: async () => '- 修了慢请求日志' });
    const [, m, d] = day.split('-').map(Number);
    const note = dayDigestNote(root, `${m}月${d}日做了什么`, new Date(2026, 10, 15));
    assert.match(note, /修了慢请求日志/);
    assert.equal(dayDigestNote(root, '帮我改个按钮', new Date(2026, 10, 15)), '');
    assert.equal(dayDigestNote(root, '昨天呢', new Date(2026, 10, 15)), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('规则版摘要之后会再试模型升级，最多重试 3 次', async () => {
  const { root, sessions } = fixture();
  try {
    const now = new Date('2026-11-09T04:00:00.000Z');
    const day = localDay('2026-11-08T02:00:00.000Z');
    const fail = async () => { throw new Error('timeout'); };
    await maybeWriteDigests(root, { now, sessions, summarize: fail, backfill: 1 });
    assert.match(fs.readFileSync(digestPath(root, day), 'utf8'), /规则摘要/);
    let calls = 0;
    const counting = async () => { calls++; throw new Error('timeout'); };
    for (let i = 0; i < 5; i++) await maybeWriteDigests(root, { now, sessions, summarize: counting, backfill: 1 });
    assert.equal(calls, 2, '首写算 1 次，之后只再试 2 次');
    const fresh = fixture();
    await maybeWriteDigests(fresh.root, { now, sessions: fresh.sessions, summarize: fail, backfill: 1 });
    await maybeWriteDigests(fresh.root, { now, sessions: fresh.sessions, summarize: async () => '- 修了日志', backfill: 1 });
    assert.match(fs.readFileSync(digestPath(fresh.root, day), 'utf8'), /修了日志[\s\S]*模型摘要/);
    fs.rmSync(fresh.root, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
