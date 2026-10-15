import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');

test('MCP 连接在后台进行，不阻塞知识库/心跳/培养恢复的启动', () => {
  assert.ok(!/await\s+mcpManager\.bootAll\(\)/.test(server.replace(/void \(async \(\) => \{ try \{[\s\S]*?\}\)\(\);/, '')),
    'bootAll 不得在 listen 回调的主路径上 await');
  const boot = server.indexOf('mcpManager.bootAll()');
  const detached = server.lastIndexOf('void (async () => {', boot);
  assert.ok(boot > 0 && detached > 0 && boot - detached < 400, 'bootAll 必须包在 void (async () => {...})() 里');
  assert.ok(server.indexOf('knowledgeRuntime.start();') > 0, '知识库启动仍在 listen 回调里');
});
