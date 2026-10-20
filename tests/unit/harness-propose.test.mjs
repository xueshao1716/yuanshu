import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectEvidence, buildProposePrompt, parseCandidates, writeCandidates, listCandidates, markCandidate,
} from '../../engine/harness-propose.mjs';

function tempWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propose-'));
  fs.mkdirSync(path.join(dir, '文档'), { recursive: true });
  fs.mkdirSync(path.join(dir, '记忆', '运行时'), { recursive: true });
  return dir;
}

test('证据：聚合慢请求、读取试验结论', () => {
  const ws = tempWs();
  fs.writeFileSync(path.join(ws, '文档', 'harness-试验.md'),
    '- 2026-10-20T01:00Z · 自我反思 · 变差 · 前 3 次 vs 后 3 次 · 失败率 0→0.67\n', 'utf8');
  fs.writeFileSync(path.join(ws, '记忆', '运行时', '慢请求.jsonl'),
    [
      JSON.stringify({ at: '2026-10-20T01:00Z', method: 'GET', path: '/api/run/overview', durationMs: 3000, status: 200 }),
      JSON.stringify({ at: '2026-10-20T01:01Z', method: 'GET', path: '/api/run/overview', durationMs: 9000, status: 200 }),
      JSON.stringify({ at: '2026-10-20T01:02Z', method: 'POST', path: '/api/chat', durationMs: 2500, status: 200 }),
    ].join('\n') + '\n', 'utf8');

  const ev = collectEvidence(ws);
  assert.equal(ev.probeRows.length, 1);
  assert.equal(ev.slowTop.length, 2, '同一路径只留最慢一条');
  assert.equal(ev.slowTop[0].key, 'GET /api/run/overview');
  assert.equal(ev.slowTop[0].durationMs, 9000);
  assert.ok(ev.hasEvidence);
});

test('提示词：限定两条、绑定证据、只允许提示词类组件', () => {
  const prompt = buildProposePrompt({ probeRows: ['变差：失败率 0→0.67'], slowTop: [{ key: 'GET /x', durationMs: 9000, status: 200 }] });
  assert.match(prompt, /提出\*\*两条\*\*候选/);
  assert.match(prompt, /system \/ guardrails \/ tools \/ skills \/ memory/);
  assert.match(prompt, /变差：失败率 0→0\.67/);
});

test('解析：能读出两条候选，缺字段的不收', () => {
  const text = `## 候选 1
- 组件：system
- 证据：失败率 0→0.67
- 假设：夜间任务缺完成定义
- 改动：第 12 条补一句"定时任务也要写完成定义"
- 回滚：删掉该句
- 验证：夜间任务失败率不升
## 候选 2
- 组件：tools
（缺改动，应丢弃）
`;
  const list = parseCandidates(text);
  assert.equal(list.length, 1);
  assert.equal(list[0].component, 'system');
  assert.match(list[0].change, /完成定义/);
});

test('落盘：写候选文件与索引，状态一律 draft', () => {
  const ws = tempWs();
  const r = writeCandidates(ws, { date: '2026-10-21', candidates: [{ component: 'system', change: '加一句', evidence: 'e', hypothesis: 'h', rollback: '删', verify: 'v' }] });
  assert.ok(r.ok);
  assert.ok(fs.existsSync(r.file));
  const body = fs.readFileSync(r.file, 'utf8');
  assert.match(body, /只提议，不落地/);
  assert.match(body, /状态：draft/);
  const list = listCandidates(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'draft');
  assert.equal(list[0].component, 'system');
});

test('状态：markCandidate 能把 draft 标成 rejected', () => {
  const ws = tempWs();
  writeCandidates(ws, { date: '2026-10-21', candidates: [{ component: 'memory', change: 'x' }] });
  const [c] = listCandidates(ws);
  const r = markCandidate(ws, c.id, 'rejected', '证据不足');
  assert.ok(r.ok);
  assert.equal(listCandidates(ws)[0].status, 'rejected');
  assert.equal(listCandidates(ws)[0].note, '证据不足');
});

test('没有证据时不写垃圾文件', () => {
  const ws = tempWs();
  const r = writeCandidates(ws, { date: '2026-10-21', candidates: [] });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(ws, '工程')), false, '不该建出空目录');
});
