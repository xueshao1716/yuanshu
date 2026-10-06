// 灵魂页「昨夜」卡的汇总（2026-10-07）：只读、取对任务、日志切对条目
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLastNight, lastLogEntry } from '../../engine/last-night.mjs';

const LOG = `
### 2026-10-05T16:00:00.000Z [0ff41abf/aaa] 每日0点复盘
# 旧的一晚
## 四、教训
1. 旧教训不该出现在卡上
### 2026-10-06T03:00:00.000Z [other123/bbb] 别的定时任务
# 别的任务
### 2026-10-06T16:00:15.711Z [0ff41abf/ccc] 每日0点复盘
# 2026-10-06 复盘
## 四、教训
1. **对用户讲代码，用户只会回「什么」。** 表达决定能否送达。
2. 会话开头查一半就断，比不查更糟
## 五、今天
\`\`\`json
{"actions":[{"text":"x 做掉并核对","kind":"fix"}]}
\`\`\`

#### 自动执行（本自动执行 2 条：完成 1，失败 1）
- [done/已结清] 结清安卓服务端欠账
  证据：扫描 346 个 package.json
- [failed] 重跑巨鞋广告图
  证据：通道 402
`;

test('lastLogEntry：取该任务最后一条，教训退回正文小节，自动执行逐行', () => {
  const e = lastLogEntry(LOG, '0ff41abf');
  assert.equal(e.at, '2026-10-06T16:00:15.711Z');
  assert.equal(e.title, '2026-10-06 复盘');
  assert.deepEqual(e.lessons, ['对用户讲代码，用户只会回「什么」。 表达决定能否送达。', '会话开头查一半就断，比不查更糟']);
  assert.equal(e.execSummary, '本自动执行 2 条：完成 1，失败 1');
  assert.deepEqual(e.execRows.map(r => [r.status, r.closed]), [['done', true], ['failed', false]]);
  assert.equal(lastLogEntry(LOG, 'nope'), null);
});

test('buildLastNight：任务按承诺账的 taskId 认；挂账分类/超期；教训提案；做梦饥饿要说出来', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lastnight-'));
  fs.mkdirSync(path.join(ws, '文档')); fs.mkdirSync(path.join(ws, '记忆'));
  fs.writeFileSync(path.join(ws, '文档', '时间引擎日志.md'), LOG);
  const old = new Date(Date.now() - 9 * 86400e3).toISOString(), batch = new Date().toISOString();
  fs.writeFileSync(path.join(ws, '记忆', '承诺兑现.json'), JSON.stringify([
    { sessionId: 'abc', status: 'pending', at: batch, kind: 'fix' },
    { sessionId: 'reflect', taskId: '0ff41abf', status: 'pending', at: old, kind: 'ask' },
    { sessionId: 'reflect', taskId: '0ff41abf', status: 'done', at: old, kind: 'fix' },
    { sessionId: 'reflect', taskId: '0ff41abf', status: 'pending', at: batch, kind: 'fix' },
    { sessionId: 'reflect', taskId: '0ff41abf', status: 'pending', at: batch, kind: 'track' },
  ]));
  const before = fs.readFileSync(path.join(ws, '记忆', '承诺兑现.json'), 'utf8');
  const out = buildLastNight({
    wsRoot: ws,
    tasks: [{ id: 'other123', prompt: '复盘别的' }, { id: '0ff41abf', prompt: '每日0点', lastRun: '2026-10-06T16:00:15.709Z', history: [{ status: 'ok', durationMs: 2676019 }] }],
    nudges: [{ subtype: 'lesson', state: 'open', draft: '- [x] 教训甲' }, { subtype: 'lesson', state: 'applied', draft: 'b' }, { subtype: 'warmth', state: 'open', draft: 'c' }],
    dream: { observed: 27, eligible: 0 },
  });
  assert.equal(out.ran, true);
  assert.equal(out.task.id, '0ff41abf');
  assert.equal(out.task.durationMs, 2676019);
  assert.deepEqual(out.commitments, { fresh: 2, pending: 3, fix: 1, track: 1, ask: 1, stale: 1 });
  assert.deepEqual(out.proposals, { lesson: 1, lessonItems: ['- [x] 教训甲'] });
  assert.equal(out.dream.fixTraces, 0);
  assert.match(out.dream.hint, /^有 27 条观测，但 0 条经人工核验/);
  assert.equal(fs.readFileSync(path.join(ws, '记忆', '承诺兑现.json'), 'utf8'), before, '只读');
  assert.equal(buildLastNight({ wsRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'ln0-')) }).ran, false);
});

test('server 注册只读路由；概览页挂了「昨夜」卡', () => {
  assert.match(fs.readFileSync('server.mjs', 'utf8'), /\["GET", "\/api\/soul\/last-night"/);
  assert.match(fs.readFileSync('frontend/src/soul/Overview.tsx', 'utf8'), /<LastNight \/>/);
});
