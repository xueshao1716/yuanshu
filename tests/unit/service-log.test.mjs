import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { serviceLogPath, tailServiceLog, listServiceLogs, localDate } from '../../engine/service-log.mjs';

function tempWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svclog-'));
  fs.mkdirSync(path.join(dir, '记忆', '运行时'), { recursive: true });
  return dir;
}

test('路径：按本地日期落在 记忆/运行时', () => {
  const ws = tempWs();
  const p = serviceLogPath(ws, new Date('2026-10-21T13:00:00+08:00'));
  assert.equal(localDate(new Date('2026-10-21T13:00:00+08:00')), '2026-10-21');
  assert.ok(p.endsWith(path.join('记忆', '运行时', '服务日志-2026-10-21.log')));
});

test('tail：只取最后 N 行，且能处理"从中间截断"', () => {
  const ws = tempWs();
  const now = new Date();
  const file = serviceLogPath(ws, now);
  const lines = Array.from({ length: 500 }, (_, i) => `line-${i}-${'x'.repeat(50)}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  const r = tailServiceLog(ws, { lines: 5, maxBytes: 4096, now });
  assert.equal(r.lines.length, 5);
  assert.match(r.lines[4], /^line-499-/);
  assert.equal(r.truncated, true, '只读尾部时应标记 truncated');
});

test('tail：文件不存在时返回空而不是抛错', () => {
  const ws = tempWs();
  const r = tailServiceLog(ws, { now: new Date('2026-10-21T00:00:00+08:00') });
  assert.deepEqual(r.lines, []);
  assert.ok(r.error);
});

test('list：按日期倒序列出日志与轮转文件', () => {
  const ws = tempWs();
  const dir = path.join(ws, '记忆', '运行时');
  for (const n of ['服务日志-2026-10-20.log', '服务日志-2026-10-21.log', '服务日志-2026-10-21.log.1', '其它.log']) {
    fs.writeFileSync(path.join(dir, n), 'x', 'utf8');
  }
  const names = listServiceLogs(ws).map(x => x.name);
  assert.equal(names.length, 3);
  assert.equal(names[0], '服务日志-2026-10-21.log.1');
  assert.ok(!names.includes('其它.log'));
});
