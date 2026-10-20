import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MIN_SAMPLES, PROBE_LOG_FILE, abCompare, appendProbeLog, markProbed, probeLogPath,
  renderProbeRow, shouldProbe, splitBeforeAfter, summarizeProbeLog, traceMetrics,
} from '../../engine/harness-probe.mjs';

const DAY = (i) => `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00Z`;
const row = (i, durationMs, status = 'ok') => ({ startedAt: DAY(i), durationMs, status, queueId: `q${i}` });

function ws(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-probe-'));
  if (typeof t?.after === 'function') t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('traceMetrics：失败率与平均耗时按客观计数算', () => {
  const m = traceMetrics([row(0, 1000), row(1, 3000, 'error'), row(2, 2000)]);
  assert.equal(m.runs, 3);
  assert.equal(m.failures, 1);
  assert.equal(m.failRate, 0.33);
  assert.equal(m.avgMs, 2000);
  assert.equal(traceMetrics([]).runs, 0);
});

test('splitBeforeAfter：history 是新的在前也切对（旧→新）', () => {
  const newestFirst = [row(0, 90000), row(1, 95000), row(2, 88000), row(3, 30000), row(4, 31000), row(5, 29000)].reverse();
  const { before, after } = splitBeforeAfter(newestFirst);
  assert.deepEqual(before.map(r => r.durationMs), [90000, 95000, 88000]);
  assert.deepEqual(after.map(r => r.durationMs), [30000, 31000, 29000]);
});

test('abCompare：变快/变慢/失败变多/样本不足 四种判定', (t) => {
  const before = [row(0, 90000), row(1, 95000), row(2, 88000)];
  assert.equal(abCompare(before, [row(3, 30000), row(4, 31000), row(5, 29000)]).verdict, 'better');
  assert.equal(abCompare(before, [row(3, 200000), row(4, 210000), row(5, 190000)]).verdict, 'worse');
  assert.equal(abCompare(before, [row(3, 90000, 'error'), row(4, 90000), row(5, 90000)]).verdict, 'worse');
  assert.equal(abCompare(before.slice(0, 2), [row(3, 90000)]).verdict, 'insufficient');
  assert.equal(abCompare(before, [row(3, 91000), row(4, 92000), row(5, 90500)]).verdict, 'no_worse');
});

test('试验记录：落盘成 markdown、可读、可汇总', (t) => {
  const root = ws(t);
  const verdict = abCompare([row(0, 90000), row(1, 95000), row(2, 88000)], [row(3, 200000), row(4, 210000), row(5, 190000)]);
  assert.equal(appendProbeLog(root, { at: DAY(5), task: '每日复盘', verdict: verdict.verdict, a: verdict.a, b: verdict.b, reason: verdict.reason }), true);
  const md = fs.readFileSync(probeLogPath(root), 'utf8');
  assert.match(md, /# Harness 试验记录/);
  assert.match(md, /变差/);
  assert.match(renderProbeRow({ at: DAY(1), verdict: 'better', a: { runs: 3 }, b: { runs: 3 } }), /变好了/);
  assert.match(summarizeProbeLog(root), new RegExp(PROBE_LOG_FILE.replace('/', '\\/')));
});

test('节流：同一任务每天只做一次对照', (t) => {
  const root = ws(t);
  const now = new Date('2026-10-20T03:00:00Z');
  assert.equal(shouldProbe(root, 'task-1', { now }), true);
  assert.equal(markProbed(root, 'task-1', { now }), true);
  assert.equal(shouldProbe(root, 'task-1', { now }), false);
  assert.equal(shouldProbe(root, 'task-1', { now: new Date('2026-10-21T03:00:00Z') }), true);
  assert.ok(fs.existsSync(path.join(root, '记忆', '运行时', 'harness-试验.json')));
});
