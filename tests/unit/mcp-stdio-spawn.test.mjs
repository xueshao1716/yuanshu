import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStdioConnection } from '../../engine/mcp-client.mjs';

test('stdio MCP：带空格的整条命令行能启动并握手（走 shell）', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/fake-mcp-stdio.mjs', import.meta.url));
  const conn = createStdioConnection({ name: 'spaced', cmd: `"${process.execPath}" --no-warnings "${fixture}"`, timeoutMs: 8000 });
  const tools = await conn.connect();
  assert.equal(tools[0].name, 'ping');
  conn.kill();
});

test('stdio MCP：命令不存在时连接失败但不抛出未捕获异常（进程不崩）', async () => {
  let uncaught = null;
  const onUncaught = e => { uncaught = e; };
  process.once('uncaughtException', onUncaught);
  const conn = createStdioConnection({ name: 'missing', cmd: 'definitely-not-a-real-binary-xyz --flag', timeoutMs: 3000 });
  await assert.rejects(conn.connect());
  await new Promise(r => setTimeout(r, 200));
  process.removeListener('uncaughtException', onUncaught);
  assert.equal(uncaught, null);
  assert.equal(conn.status().connected, false);
});
