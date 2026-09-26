import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const file = new URL('../../engine/tool-availability.mjs', import.meta.url);
test('availability guidance is based on the actual request, not a historical bash-only claim', async () => {
  assert.ok(fs.existsSync(file), 'missing actual-tool guidance');
  const { toolAvailabilityPrompt } = await import(file);
  const prompt = toolAvailabilityPrompt(['bash', 'read', 'write', 'edit', 'generate_image']);
  assert.ok(prompt.includes('bash、read、write、edit、generate_image'));
  assert.ok(prompt.includes('优先使用 read/write/edit'));
  assert.ok(prompt.includes('不得通过 bash 绕过'));
  const restricted = toolAvailabilityPrompt(['read', 'web_search']);
  assert.ok(restricted.includes('read、web_search'));
  assert.ok(!restricted.includes('优先使用 read/write/edit'));
  assert.ok(!restricted.includes('可用工具：bash'));
  assert.ok(toolAvailabilityPrompt([]).includes('没有工具可用'));
});

test('unified requests refresh availability after effective tools are selected', () => {
  const source = fs.readFileSync(new URL('../../engine/unified-chat.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('toolAvailabilityPrompt('));
  assert.ok(source.indexOf('toolAvailabilityPrompt(toolDefs') > source.indexOf('const toolDefs = opts.tools'));
});
