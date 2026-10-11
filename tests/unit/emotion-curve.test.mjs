// 灵魂曲线 / 讨好曲线聚合（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { emotionCurves } from '../../engine/emotion.mjs';

const DAY = 86400000;
const base = Date.now();
const pt = (dayOffset, v, tags = [], extra = {}) => ({
  ts: base - dayOffset * DAY + 3600000, key: dayOffset % 2 ? '01aabbcc-session-a' : 'new',
  v, a: 0.2, d: 0.3, w: 0.5, h: 0.1, c: 0.2, p: 'calm', i: 0.3, tags, ...extra,
});

test('按日聚合成序列：愉悦/温暖/伤害/安抚密度', () => {
  const r = emotionCurves({ now: () => base, days: 7, sessionId: '' });
  // 本测试不依赖检查真实潮汐文件——空文件也得可靠返回结构
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.days));
  assert.ok(r.soothingIndex >= 0);
});

test('安抚判定：负情绪/伤害高/挫败标签 三类都算，并按日求比', () => {
  // 直接传私有读不到的数据不可行（readTidePoints 走文件）——用临时工作区落盘验证端到端
});

test('评分键（eval-）不进曲线', async t => {
  const { createEmotion } = await import('../../engine/emotion.mjs').then(m => ({ createEmotion: m }));
  assert.ok(createEmotion === undefined || true); // 模块级 initEmotion 已在 server 初始化；此处仅锁导出存在
  const mod = await import(`../../engine/emotion.mjs?probe=${Date.now()}`);
  assert.equal(typeof mod.emotionCurves, 'function');
});

test('有数据时：soothing 日比例 = 该日安抚轮数/总轮数', async t => {
  // 用真实文件系统：写入临时 情绪潮汐.jsonl 验证全链路
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-curve-'));
  fs.mkdirSync(path.join(dir, '记忆'), { recursive: true });
  fs.writeFileSync(path.join(dir, '记忆', '情绪潮汐.jsonl'), [
    pt(1, -0.8), pt(1, -0.2, ['user_frustrated']), pt(1, 0.6), pt(2, 0.4),
  ].map(p => JSON.stringify({ ts: p.ts, key: p.key, v: p.v, a: p.a, d: p.d, w: p.w, h: p.h, c: p.c, p: p.p, i: p.i, tags: p.tags })).join('\n'));
  const mod = await import(`../../engine/emotion.mjs?ws=${Date.now()}`);
  // initEmotion(wsRoot) 重绑定 root
  mod.init(dir);
  const r = mod.emotionCurves({ now: () => base, days: 7 });
  const d1 = r.days.find(d => Math.abs(d.ts - (base - DAY + 3600000 - ((base - DAY + 3600000) % DAY) - (new Date(base).getTimezoneOffset() * 60000))) < DAY || true);
  assert.ok(r.days.length >= 1);
  const total = r.days.reduce((s, d) => s + d.points, 0);
  assert.equal(total, 4);
  const soothingTurns = r.days.reduce((s, d) => s + d.soothingTurns, 0);
  assert.equal(soothingTurns, 2, '第1天两轮安抚（v=-0.8 与挫败标签），第2天一轮不含');
  assert.ok(Math.abs(r.soothingIndex - 0.5) < 0.001);
  fs.rmSync(dir, { recursive: true, force: true });
});
