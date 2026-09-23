import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { initUnifiedChat, unifiedChat, createRunHistorySnapshot } from '../../engine/unified-chat.mjs';
import { initDshKeys } from '../../engine/dsh-keys.mjs';
import { readOpenAIChatStream } from '../../engine/openai-stream.mjs';
import { readMessagesStream } from '../../engine/anthropic-stream.mjs';

async function fixture(reply, run, native = false) {
  const requests = [], executed = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply(requests.length, body)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = { provider: 'continuation-test', id: 'test', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: native ? 'anthropic-messages' : 'openai-completions', maxTokens: 8192, contextWindow: 32000 };
  const readJsonFile = file => file === 'auth' ? { [model.provider]: { key: 'fixture' } } : { [model.provider]: { models: [model] } };
  initDshKeys({ authPath: 'auth', modelsPath: 'models', readJsonFile });
  initUnifiedChat({ authPath: 'auth', modelsPath: 'models', readJsonFile, getModelList: () => [model],
    UNIFIED_TOOLS: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { page: { type: 'number' } } } } }],
    executeUnifiedTool: async (name, args) => { executed.push({ name, args }); return { text: `page ${args.page} saved` }; },
  });
  try { await run({ model, requests, executed, chat: opts => unifiedChat(model, [{ role: 'user', content: '逐页收集并验证交付' }], opts) }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const answer = text => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const call = n => ({ choices: [{ message: { content: `处理第 ${n} 页`, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ page: n }) } }] }, finish_reason: 'tool_calls' }] });

test('progressing task continues past 20 turns without replay or model switch', async () => {
  await fixture(n => n <= 25 ? call(n) : answer('已验证25页'), async ({ chat, executed, requests }) => {
    const notes = [], checkpoints = [];
    const result = await chat({ onNote: text => notes.push(text), onCheckpoint: cp => checkpoints.push(cp) });
    assert.equal(result.error, undefined); assert.equal(result.text, '已验证25页');
    assert.equal(requests.length, 26); assert.equal(executed.length, 25);
    assert.equal(new Set(executed.map(x => x.args.page)).size, 25);
    assert.ok(notes.some(text => text.includes('自动接续')));
    assert.equal(checkpoints.at(-1).turn, 26);
  });
});

test('explicit round limit returns truthful reason and preserves completed history', async () => {
  await fixture(call, async ({ chat, executed }) => {
    const result = await chat({ maxTurns: 2 });
    assert.equal(executed.length, 2);
    assert.equal(result.paused, true); assert.equal(result.error, undefined);
    assert.equal(result.pauseReason, 'tool_turn_limit');
    assert.match(result.message, /2 轮/); assert.doesNotMatch(result.message, /输出被截断|最大值/);
    assert.equal(result.history.filter(x => x.role === 'tool').length, 2);
  });
});

test('progressing task crosses 60 turns and completes without replay', async () => {
  await fixture(n => n <= 65 ? call(n) : answer('完成65页'), async ({ chat, executed, requests }) => {
    const result = await chat();
    assert.equal(result.error, undefined); assert.equal(result.paused, undefined);
    assert.equal(result.text, '完成65页'); assert.equal(requests.length, 66);
    assert.equal(executed.length, 65); assert.equal(new Set(executed.map(x => x.args.page)).size, 65);
  });
});

test('elapsed budget pauses after saving tool results, without starting another request', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  await fixture(n => { t.mock.timers.tick(1001); return call(n); }, async ({ chat, executed, requests }) => {
    const checkpoints = [];
    const result = await chat({ executionBudgetMs: 1000, onCheckpoint: cp => checkpoints.push(cp) });
    assert.equal(result.paused, true); assert.equal(result.pauseReason, 'execution_budget');
    assert.equal(result.error, undefined); assert.equal(requests.length, 1);
    assert.equal(executed.length, 1); assert.equal(checkpoints.at(-1).phase, 'tool_results');
    assert.equal(result.history.at(-1).role, 'tool');
  });
});

test('repeated identical tools still stop before automatic continuation', async () => {
  await fixture(() => call(1), async ({ chat, requests }) => {
    const result = await chat();
    assert.match(result.error, /循环|重复|停滞/); assert.ok(requests.length <= 3);
  });
});

test('abort at batch boundary does not start another request', async () => {
  await fixture(call, async ({ chat, requests }) => {
    const controller = new AbortController();
    const result = await chat({ signal: controller.signal, onCheckpoint: cp => { if (cp.phase === 'tool_results' && cp.turn === 20) controller.abort(); } });
    assert.equal(result.aborted, true); assert.equal(requests.length, 20);
  });
});

test('OpenAI length resumes text automatically and preserves partial answer', async () => {
  await fixture(n => n === 1 ? { choices: [{ message: { content: '第一部分。' }, finish_reason: 'length' }] } : answer('第二部分。'), async ({ chat, requests }) => {
    const result = await chat();
    assert.equal(requests.length, 2); assert.equal(result.text, '第一部分。第二部分。');
    assert.match(requests[1].messages.at(-1).content, /无需.*分块写/);
  });
});

test('malformed tool arguments never execute; retry asks for bounded chunks', async () => {
  await fixture(n => n === 1 ? { choices: [{ message: { tool_calls: [{ id: 'broken', function: { name: 'lookup', arguments: '{"page":' } }] }, finish_reason: 'length' }] } : n === 2 ? call(2) : answer('已完成'), async ({ chat, executed, requests }) => {
    const result = await chat();
    assert.equal(result.error, undefined); assert.deepEqual(executed.map(x => x.args.page), [2]);
    assert.match(requests[1].messages.at(-1).content, /每块.*字符/);
    assert.equal(requests[1].messages.some(x => x.tool_calls?.some(c => c.id === 'broken')), false);
  });
});

test('native max_tokens uses automatic recovery, not immediate failure', async () => {
  await fixture(n => ({ type: 'message', model: 'test', content: [{ type: 'text', text: n === 1 ? '开头。' : '结尾。' }], stop_reason: n === 1 ? 'max_tokens' : 'end_turn' }), async ({ chat, requests }) => {
    const result = await chat(); assert.equal(result.error, undefined);
    assert.equal(requests.length, 2); assert.equal(result.text, '开头。结尾。');
  }, true);
});

test('stream parser retains finish reason and actual model for both SSE and JSON', async () => {
  for (const raw of [JSON.stringify({ model: 'actual', choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }), 'data: {"model":"actual","choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n']) {
    const result = await readOpenAIChatStream(new Response(raw).body);
    assert.equal(result.finishReason, 'length'); assert.equal(result.model, 'actual');
  }
});

test('manual resume after turn 20 or 60 keeps numbering and gets a bounded new budget', async () => {
  for (const turn of [20, 60]) await fixture(() => answer('接续完成'), async ({ chat, requests }) => {
      const snapshot = createRunHistorySnapshot([{ role: 'user', content: 'continue saved work' }], { turn });
      const checkpoints = [];
      const result = await chat({ resumeSnapshot: snapshot, resumeCheckpointKind: 'tool_results', onCheckpoint: cp => checkpoints.push(cp) });
      assert.equal(result.error, undefined); assert.equal(requests.length, 1);
      assert.equal(checkpoints[0].turn, turn + 1);
    });
});

test('repeated truncation stops truthfully after two automatic retries', async () => {
  await fixture(() => ({ choices: [{ message: { content: '片段。' }, finish_reason: 'length' }] }), async ({ chat, requests }) => {
    const result = await chat();
    assert.equal(requests.length, 3); assert.equal(result.errorCode, 'output_truncated');
    assert.match(result.error, /自动尝试分块/); assert.doesNotMatch(result.error, /最大值|回我一句/);
    assert.equal(result.text, '片段。片段。片段。', '最终失败也必须保留已经流出的最后一段');
    assert.ok(result.history.length > 1);
  });
});

test('native truncated SSE exposes malformed arguments for safe retry only on max_tokens', async () => {
  for (const reason of ['max_tokens', 'tool_use']) {
    const events = [
      { type: 'message_start', message: { model: 'native', usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'bad', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"page":' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: reason } }, { type: 'message_stop' },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const result = await readMessagesStream(new Response(events).body);
    if (reason === 'max_tokens') {
      assert.equal(result.error, undefined); assert.equal(result.finishReason, reason);
      assert.equal(result.message.tool_calls[0].function.arguments, '{"page":');
      assert.equal(result.message.anthropic_content.length, 0);
    } else assert.ok(result.error);
  }
});
