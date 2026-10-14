import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('chat 遇到只有编号没有文件的会话时按原 id 重建，不再 404', () => {
  const server = read('server.mjs');
  const i = server.indexOf('entry = await openSession(sessionId);');
  const win = server.slice(i, i + 700);
  assert.match(win, /hasSessionSequence\(sessionId\)/);
  assert.match(win, /createSession\(undefined, \{ group: "workspace", id: sessionId \}\)/);
  assert.match(read('engine/session-manager.mjs'), /_SessionManager\.create\(_cwd, _sessionsDir, \{ id: fixedId \}\)/);
});
