import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { initUnifiedChat, unifiedChat } from '../../engine/unified-chat.mjs';
import { initDshKeys } from '../../engine/dsh-keys.mjs';

const toolMessage = { content: null, tool_calls: [{ id: 'grep-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }] };

test('中途插话在工具结果之后、下一次模型调用之前注入，且不顶替当前任务', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const message = requests.length === 1 ? toolMessage : { content: '按插话改了。' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ message }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const model = { provider: 'mock', id: 'steer', baseUrl: `http://127.0.0.1:${server.address().port}`, api: 'openai-completions' };
    const readJsonFile = p => p === 'a' ? { mock: { key: 't' } } : { mock: { models: [model] } };
    initDshKeys({ authPath: 'a', modelsPath: 'm', readJsonFile });
    const queue = [];
    initUnifiedChat({ authPath: 'a', modelsPath: 'm', readJsonFile, getModelList: () => [model], getDefaultModel: () => model,
      UNIFIED_TOOLS: [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }],
      // 插话恰好在第一轮工具执行期间到达
      executeUnifiedTool: async () => { queue.push('别 grep 了，直接改 ea1006d0'); return { text: 'ok', isError: false }; },
    });
    const noted = [];
    const result = await unifiedChat(model, [{ role: 'user', content: '找最新设计' }], {
      maxTurns: 4, takeSteering: () => queue.splice(0), onSteer: t => noted.push(t) });
    assert.equal(result.error, undefined);
    assert.equal(requests.length, 2);
    assert.ok(!requests[0].messages.some(m => /中途插话/.test(m.content || '')), '第一轮之前没有插话');
    const msgs = requests[1].messages;
    const toolIdx = msgs.findIndex(m => m.role === 'tool' && m.tool_call_id === 'grep-1');
    const steerIdx = msgs.findIndex(m => /【伙伴中途插话】别 grep 了/.test(m.content || ''));
    assert.ok(toolIdx > 0 && steerIdx > toolIdx, '插话排在工具结果之后，配对不被切断');
    assert.equal(msgs[steerIdx].role, 'system');
    assert.equal(msgs.findLast(m => m.role === 'user').content, '找最新设计', '当前任务仍是最后一条 user');
    assert.deepEqual(noted, ['别 grep 了，直接改 ea1006d0']);
  } finally { await new Promise(r => server.close(r)); }
});

test('两条引擎都接了插话：元枢循环 takeSteering，Pi 引擎原生 steer()', () => {
  const read = p => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
  const unified = read('engine/unified-chat.mjs'), server = read('server.mjs');
  assert.equal((unified.match(/takeSteering: steeringTake/g) || []).length, 2, '主循环与规划只读循环都要接');
  assert.ok(server.includes('steering.sink = deliver'));
  assert.ok(server.includes('agent.steer('));
  assert.ok(server.includes("/^\\/api\\/runs\\/([^/]+)\\/steer$/"));
});
