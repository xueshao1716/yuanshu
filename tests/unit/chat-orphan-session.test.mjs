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
  // 2026-11-05：createSession 现在支持 cwd 覆盖，调用形式变成 (cwd || _cwd)；
// 原断言写死 _cwd，属契约过期。这里只要求「用 fixedId 建会话」这个实质。
assert.match(read('engine/session-manager.mjs'), /_SessionManager\.create\([^)]*_cwd, _sessionsDir, \{ id: fixedId \}\)/);
});
