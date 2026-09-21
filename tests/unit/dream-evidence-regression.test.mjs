import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnTheSpotFix } from '../../engine/reflection-exec.mjs';
import { listTraces, loadTrace, replayTrace } from '../../engine/trace.mjs';
import { replayExplore } from '../../engine/explore-policy.mjs';
import { dream, loadEpisodes, appendEpisodes } from '../../engine/dream.mjs';

test('failed independent verification cannot survive as a replay success', async t => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const result = await runOnTheSpotFix({ problem: '修复格式解析错误', wsRoot, store: new Map(),
    runTurn: async prompt => /独立验证者/.test(prompt)
      ? '```json\n{"verdict":"FAIL","evidence":"断言失败","checks":["node --test"]}\n```'
      : '```json\n{"status":"done","evidence":"独占自述标记"}\n```' });
  assert.equal(result.ok, false);
  const trace = loadTrace(wsRoot, listTraces(wsRoot)[0].id);
  assert.equal(trace.closed.score, 0);
  assert.equal(replayExplore(trace, { retryOnFailure: 3 }).score, 0);
  assert.equal(replayTrace(trace).best ?? 0, 0);
});

test('the actual verifier call does not receive executor self-assurance', async () => {
  let verifierPrompt = '';
  await runOnTheSpotFix({ problem: '修复格式解析错误', store: new Map(), runTurn: async prompt => {
    if (/独立验证者/.test(prompt)) {
      verifierPrompt = prompt;
      return '```json\n{"verdict":"PASS","checks":["检查产物"]}\n```';
    }
    return '```json\n{"status":"done","evidence":"独占自述标记"}\n```';
  } });
  assert.ok(verifierPrompt && !verifierPrompt.includes('独占自述标记'));
});

test('legacy execution followed by failed verification is not successful', () => {
  const trace = { kind: 'fix-attempt', nodes: [
    { id: 'n1', action: '执行轮', score: 1, cost: 2 },
    { id: 'n2', action: '独立验证', outcome: 'FAIL', score: 0, cost: 0 },
  ] };
  assert.equal(replayExplore(trace).score, 0);
  assert.equal(replayTrace(trace).best ?? 0, 0);
});

test('unobserved retries are unsupported, not free failed attempts', () => {
  const result = replayExplore({ nodes: [{ score: 0, cost: 2 }] }, { retryOnFailure: 3 });
  assert.equal(result.covered, false);
});

test('past skill activation alone cannot produce a promotion proposal', () => {
  const result = dream({ kind: 'skill-match', episodes: [{ input: '画图', choice: 'image' }],
    incumbentId: 'old', candidates: [{ id: 'new' }], rank: (_ep, p) => p.id === 'new' ? ['image'] : [] });
  assert.equal(result.winner, null);
  assert.equal(result.eligibleEpisodes, 0);
});

test('different task contexts and failed labels never merge into accepted labels', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-labels-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  appendEpisodes(root, [
    { kind: 'skill-match', input: '继续', choice: 'image', runId: 'a', verification: { verdict: 'PASS', source: 'human' } },
    { kind: 'skill-match', input: '继续', choice: 'files', runId: 'b', verification: { verdict: 'FAIL', source: 'human' } },
  ]);
  assert.equal(loadEpisodes(root).length, 2);
});
