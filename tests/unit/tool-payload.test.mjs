import test from 'node:test';
import assert from 'node:assert/strict';
import { slimToolDefs } from '../../engine/tool-payload.mjs';

const def = (name, pad = 0) => ({ type: 'function', function: { name, description: 'x'.repeat(pad), parameters: { type: 'object' } } });

test('超大 MCP 工具不进默认工具表，内置工具和小 MCP 工具保留', () => {
  const out = slimToolDefs([def('bash'), def('mcp_small', 100), def('mcp_huge', 20000), def('read', 50000)]);
  assert.deepEqual(out.map(d => d.function.name), ['bash', 'mcp_small', 'read']);
  assert.deepEqual(out.dropped, ['mcp_huge']);
});
test('没有超大工具时原样返回同一个数组，非数组原样透传', () => {
  const list = [def('bash'), def('mcp_a', 10)];
  assert.equal(slimToolDefs(list), list);
  assert.equal(slimToolDefs(undefined), undefined);
});
test('上限可调', () => {
  assert.equal(slimToolDefs([def('mcp_a', 500)], { maxMcpBytes: 100 }).length, 0);
});
