import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initSubagent, spawnSubagent, getSubagentHistory } from '../../engine/subagent.mjs';
import { DELEGATE_TASK_TOOL, DELEGATE_FORK_TOOL, execDelegateTask } from '../../engine/yuanshu-delegate.mjs';
import { forkSeedFromHistory } from '../../engine/subagent-fork.mjs';
import { subagentBudget } from '../../engine/subagent-contract.mjs';
import { SubagentTraceStore } from '../../engine/subagent-traces.mjs';

async function setup(t, { native = false, stop, text = JSON.stringify({ result: '完整结论'.repeat(60), evidence: [], confidence: .8 }), maxTokens = 16000, contextWindow = 128000 } = {}) {
  const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-contract-'));
  t.after(() => fs.rm(traceDir, { recursive: true, force: true }));
  const requests = [];
  const model = { provider: 'fixture', id: 'reasoner', reasoning: true, api: native ? 'anthropic-messages' : 'openai-completions', maxTokens, contextWindow, baseUrl: 'https://fixture.invalid/v1' };
  initSubagent({ traceDir, getFlashModel: () => model, getDefaultModel: () => model,
    authReader: () => ({ fixture: { key: 'test-only' } }), modelReader: () => ({ fixture: { models: [model] } }),
    httpFetch: async (url, opts) => {
      requests.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => native
        ? { model: 'served-reasoner', content: [{ type: 'text', text }], stop_reason: stop || 'end_turn', usage: { input_tokens: 40, output_tokens: 120 } }
        : { model: 'served-reasoner', choices: [{ finish_reason: stop || 'stop', message: { content: text } }], usage: { prompt_tokens: 40, completion_tokens: 120 } } };
    },
  });
  return { traceDir, requests };
}

test('ordinary reasoning children reserve useful output and preserve a task beyond 1000 characters', async t => {
  const { requests } = await setup(t);
  const task = '资料'.repeat(600) + '末尾必须保留';
  const r = await spawnSubagent({ task });
  assert.equal(r.done, true);
  assert.ok(r.result.length > 80);
  assert.equal(requests[0].body.max_tokens, 8192);
  assert.equal(requests[0].body.reasoning_effort, 'low');
  assert.equal(requests[0].body.messages.at(-1).content, task);
});

for (const native of [false, true]) test(`truncation remains output_limit with budget and usage (${native ? 'Messages' : 'Chat'})`, async t => {
  const { traceDir, requests } = await setup(t, { native, stop: native ? 'max_tokens' : 'length', text: '{"result":"partial', maxTokens: 3000 });
  const r = await spawnSubagent({ task: '分析', sessionId: 's', runId: 'p' });
  assert.equal(r.done, false);
  assert.equal(r.errorCode, 'output_limit');
  assert.match(r.error, /3000.*token/);
  assert.doesNotMatch(r.error, /不是预期 JSON/);
  assert.equal(requests.length, 1, 'no hidden paid retry or model switch');
  const [row] = await getSubagentHistory({ traceDir, runId: 'p' });
  assert.equal(row.diagnostics.outputBudget, 3000);
  assert.equal(row.diagnostics.outputTokens, 120);
  assert.equal(row.diagnostics.usedModel, 'fixture/served-reasoner');
  assert.equal(row.diagnostics.errorCode, 'output_limit');
});

test('complete but invalid result explains the actual envelope, not an invented 80-character rule', async t => {
  await setup(t, { text: '{"year":"1978"}' });
  const r = await execDelegateTask({ task: '提取年份' });
  assert.equal(r.isError, true);
  assert.match(r.text, /result.*evidence.*confidence/);
  assert.doesNotMatch(r.text, /80 字|禁止数组/);
});

test('an array containing a result object is not mistaken for the required outer object', async t => {
  await setup(t, { text: '[{"result":"not an envelope"}]' });
  const r = await spawnSubagent({ task: '分析' });
  assert.equal(r.done, false);
  assert.equal(r.errorCode, 'invalid_output');
});

test('a complete fenced JSON envelope remains supported', async t => {
  await setup(t, { text: '```json\n{"result":"完整", "evidence":["事实"]}\n```' });
  assert.equal((await spawnSubagent({ task: '分析' })).done, true);
});

test('overlong output is rejected instead of silently returning 4000 characters as complete', async t => {
  await setup(t, { text: JSON.stringify({ result: '文'.repeat(8001) }) });
  const r = await spawnSubagent({ task: '分析' });
  assert.equal(r.done, false);
  assert.equal(r.errorCode, 'output_limit');
});

for (const args of [{ task: '文'.repeat(8001) }, { task: '分析', context: ['文'.repeat(2001)] }, { task: '分析', context: Array(9).fill('事实') }]) {
  test(`oversized explicit input is rejected before HTTP (${args.task.length},${args.context?.length || 0})`, async t => {
    const { requests } = await setup(t);
    const r = await execDelegateTask(args);
    assert.equal(r.isError, true);
    assert.match(r.text, /输入.*上限/);
    assert.equal(requests.length, 0);
  });
}

test('context budget protects a small declared model window before HTTP', async t => {
  const { requests } = await setup(t, { contextWindow: 2048 });
  const r = await spawnSubagent({ task: '资料'.repeat(1000) });
  assert.equal(r.done, false);
  assert.equal(r.errorCode, 'context_limit');
  assert.equal(requests.length, 0);
});

test('fork marks per-message clipping and fits its notice inside the character budget', () => {
  const r = forkSeedFromHistory([{ role: 'tool', content: 'omitted' }, { role: 'assistant', content: '文'.repeat(1000) }], { maxChars: 150, perMessageChars: 800 });
  assert.equal(r.truncated, true);
  assert.ok(r.messages.reduce((n, m) => n + m.content.length, 0) <= 150);
  assert.doesNotMatch(JSON.stringify(r.messages), /自己重新查/);
  assert.equal(forkSeedFromHistory([{ role: 'assistant', content: '文'.repeat(1000) }]).truncated, true);
});

test('delegate descriptions state analysis-only capabilities and the real output envelope', () => {
  for (const tool of [DELEGATE_TASK_TOOL, DELEGATE_FORK_TOOL]) {
    assert.match(tool.function.description, /不联网/);
    assert.match(tool.function.description, /result/);
    assert.doesNotMatch(tool.function.description, /廉价 flash|独立调研/);
  }
});

test('budget respects both declared output maximum and remaining context window', () => {
  const messages = [{ role: 'user', content: '分析资料'.repeat(200) }];
  const budget = subagentBudget({ reasoning: true, maxTokens: 16000, contextWindow: 4096 }, messages);
  assert.ok(budget.outputBudget < 8192);
  assert.equal(budget.outputBudget + budget.inputTokensEstimate + 512, 4096);
  assert.equal(subagentBudget({ maxTokens: 500 }, []).outputBudget, 500);
  assert.equal(subagentBudget({}, []).outputBudget, 4096);
});

test('native Messages budget does not leak OpenAI reasoning parameters', async t => {
  const { requests } = await setup(t, { native: true });
  assert.equal((await spawnSubagent({ task: '分析' })).done, true);
  assert.equal(requests[0].body.max_tokens, 8192);
  assert.equal(requests[0].body.reasoning_effort, undefined);
});

test('oversized inherited seed is rejected without a request', async t => {
  const { requests } = await setup(t);
  const r = await spawnSubagent({ task: '分析', seed: [{ role: 'assistant', content: '文'.repeat(12001) }] });
  assert.equal(r.errorCode, 'context_limit');
  assert.equal(requests.length, 0);
});

test('diagnostic metadata survives reload without persisting raw response or secrets', async t => {
  const { traceDir } = await setup(t);
  const store = new SubagentTraceStore(traceDir);
  await store.begin({ runId: 'diagnostics' });
  await store.finish('diagnostics', { status: 'failed', diagnostics: {
    outputBudget: 8192, outputTokens: 35, reasoningTokens: -1, errorCode: 'output_limit',
    usedModel: 'api_key=private-test-value', rawResponse: 'do-not-store', thinking: 'private-thinking',
  } });
  const [r] = await new SubagentTraceStore(traceDir).history();
  assert.equal(r.diagnostics.outputTokens, 35);
  assert.equal(r.diagnostics.reasoningTokens, null);
  assert.doesNotMatch(JSON.stringify(r), /private-test-value|do-not-store|private-thinking/);
});

test('fork budgets are bounded even for tiny or invalid limits', () => {
  const history = [{ role: 'assistant', content: '文'.repeat(1000) }];
  for (const maxChars of [0, 1, 20, 150]) {
    const r = forkSeedFromHistory(history, { maxChars });
    assert.ok(r.messages.reduce((n, m) => n + m.content.length, 0) <= maxChars);
    assert.equal(r.truncated, true);
  }
  assert.ok(forkSeedFromHistory(history, { maxChars: NaN }).messages.length > 0);
});
