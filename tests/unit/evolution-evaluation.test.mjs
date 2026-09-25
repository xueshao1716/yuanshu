import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAdvisoryScore, runPromptEvaluation } from '../../engine/evolution-evaluation.mjs';
import { initEvolutionApi, proposeEvolution, listEvolution, startEvolutionEvaluation, applyEvolution, dismissEvolution, proposeMemoryNudge, listMemoryNudges } from '../../engine/evolution-api.mjs';

test('scores are advisory, malformed numbers never become a perfect score', () => {
  assert.equal(parseAdvisoryScore('85/100'), 85);
  for (const s of ['80 and 90', '101', '-2', '', 'score: 100']) assert.equal(parseAdvisoryScore(s), null);
});

test('timeouts abort the request and stop subsequent model calls', async () => {
  let calls = 0, signal;
  await assert.rejects(runPromptEvaluation({ original: 'template', variants: [], model: {}, isCurrent: () => true, timeoutMs: 10,
    chat: async (_m, _messages, opts) => { calls++; signal = opts.signal; assert.equal(opts.tools, false); return new Promise(() => {}); } }), /超时/);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('excess questions and oversized answers fail without silently truncating', async () => {
  for (const mode of ['questions', 'answer']) {
    let calls = 0;
    await assert.rejects(runPromptEvaluation({ original: 'template', variants: [], model: {}, isCurrent: () => true,
      chat: async () => ({ text: ++calls === 1 ? JSON.stringify({ questions: mode === 'questions' ? ['1','2','3','4','5'] : ['q'] }) : 'x'.repeat(12001) }) }), mode === 'questions' ? /题目/ : /上限/);
    assert.equal(calls, mode === 'questions' ? 1 : 2);
  }
});

test('interrupted and partial model output cannot be accepted as complete evidence', async () => {
  for (const flag of ['aborted', 'partial', 'truncated', 'interrupted']) {
    await assert.rejects(runPromptEvaluation({ original: 'template', variants: [], model: {}, isCurrent: () => true,
      chat: async () => ({ text: '{"questions":["q"]}', [flag]: true }) }), /未完整/);
  }
});

test('evaluation retains returned model provenance without guessing missing facts', async () => {
  let calls = 0;
  const result = await runPromptEvaluation({ original: 'template', variants: [], model: { provider: 'requested', id: 'one' }, isCurrent: () => true,
    chat: async () => ({ text: ++calls === 1 ? '{"questions":["q"]}' : calls === 2 ? 'answer' : '90',
      ...(calls === 2 ? { usedModel: { provider: 'actual', id: 'two' } } : {}) }) });
  assert.equal(result.calls.length, 3);
  assert.equal(result.calls[0].actualModel, null);
  assert.deepEqual(result.calls[1].actualModel, { provider: 'actual', id: 'two' });
});

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-eval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompts = path.join(root, 'prompts'); fs.mkdirSync(prompts);
  const original = 'You are a careful helper. Follow instructions and verify answers before delivery.';
  fs.writeFileSync(path.join(prompts, 'demo.md'), original);
  initEvolutionApi({ root, prompts, chat: async () => ({ text: JSON.stringify({ variants: [{ label: 'A', content: original + ' Cite sources.' }] }) }) });
  const { id } = await proposeEvolution({ name: 'demo' });
  return { root, prompts, original, id };
}

test('evaluation merges into current pool, blocks duplicates and binds candidate content', async t => {
  const f = await setup(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve });
  let calls = 0;
  initEvolutionApi({ ...f, chat: async (_m, messages) => {
    if (++calls === 1) { await blocked; return { text: '{"questions":["task"]}' }; }
    return { text: messages[0].content.includes('严格评委') ? '90' : 'complete response' };
  } });
  const run = startEvolutionEvaluation(f.id, { provider: 'fixture', id: 'fixture' });
  assert.ok(startEvolutionEvaluation(f.id, {}).error);
  proposeMemoryNudge({ subtype: 'curiosity', message: 'parallel change', residue: 0.5 });
  release();
  assert.equal((await run.completion).ok, true);
  assert.equal(listMemoryNudges().length, 1);
  assert.equal(calls, 5);
  const poolFile = path.join(f.root, '工程/经验库/improvements.jsonl');
  const rows = fs.readFileSync(poolFile, 'utf8').trim().split('\n').map(JSON.parse);
  const proposal = rows.find(x => x.id === f.id);
  proposal.variants[0].content += ' Modified after evaluation.';
  fs.writeFileSync(poolFile, rows.map(JSON.stringify).join('\n'));
  assert.match(applyEvolution(f.id, 0, { evaluationId: run.evaluationId, comparisons: ['better'], note: 'checked' }).error, /变化/);
  assert.equal(fs.readFileSync(path.join(f.prompts, 'demo.md'), 'utf8'), f.original);
});

test('dismissal during evaluation is retained and halts remaining calls', async t => {
  const f = await setup(t);
  let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve });
  initEvolutionApi({ ...f, chat: async () => { calls++; await blocked; return { text: '{"questions":["task"]}' }; } });
  const run = startEvolutionEvaluation(f.id, {});
  await Promise.resolve(); await Promise.resolve();
  dismissEvolution(f.id); release();
  assert.ok((await run.completion).error);
  assert.equal(listEvolution()[0].state, 'dismissed');
  assert.equal(listEvolution()[0].evaluation.status, 'failed');
  assert.equal(calls, 1);
});

test('orphaned running records are reported interrupted instead of polling forever', async t => {
  const f = await setup(t);
  const file = path.join(f.root, '工程/经验库/improvements.jsonl');
  const row = listEvolution()[0];
  row.evaluation = { id: 'previous-process', status: 'running' };
  fs.writeFileSync(file, JSON.stringify(row));
  assert.equal(listEvolution()[0].evaluation.status, 'failed');
  assert.match(listEvolution()[0].evaluation.error, /中断/);
});
