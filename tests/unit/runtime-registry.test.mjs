// 运行时实例登记（engine/runtime-registry.mjs）：谁在跑、哪份版本、谁持有端口——变成可查事实。
// 今天的事故：多份 server.mjs 抢 8787，我从外部看不出谁在服务，验证时抓到空转实例的日志，
// 得出了错的结论。这个模块就是补那份登记，外加把"启动事实"写成机器可读的 jsonl。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  heartbeat, liveInstances, portOwner, recordStartup, recentStartups, selfCheck,
  instancePath, runtimeDir, HEARTBEAT_STALE_MS,
} from '../../engine/runtime-registry.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-runtime-'));

test('心跳：写下来、读得回，落在 记忆/运行时 下', () => {
  const root = tmp();
  const r = heartbeat(root, { pid: 111, version: '2.76.0', port: 8787, ownsPort: true });
  assert.equal(r.ok, true);
  assert.ok(instancePath(root, 111).startsWith(path.join(root, '记忆', '运行时')));
  const list = liveInstances(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].version, '2.76.0');
  assert.equal(list[0].ownsPort, true);
  assert.equal(portOwner(root).pid, 111);
});

test('存活判定：过期心跳会被忽略并顺手清掉登记文件', () => {
  const root = tmp();
  heartbeat(root, { pid: 222, version: '2.76.0', ownsPort: true });
  // 把心跳时间改老
  const f = instancePath(root, 222);
  const row = JSON.parse(fs.readFileSync(f, 'utf8'));
  row.at = new Date(Date.now() - HEARTBEAT_STALE_MS - 5000).toISOString();
  fs.writeFileSync(f, JSON.stringify(row), 'utf8');
  assert.equal(liveInstances(root).length, 0, '过期实例不该算活着');
  assert.equal(fs.existsSync(f), false, '顺手清掉');
  assert.equal(portOwner(root), null);
});

test('自检：同版本占用 → 判为重复；无占用 → 可正常启动', () => {
  const root = tmp();
  assert.equal(selfCheck(root, { myPid: 1, myVersion: '2.76.0' }).duplicate, false);
  heartbeat(root, { pid: 333, version: '2.76.0', ownsPort: true });
  const dup = selfCheck(root, { myPid: 1, myVersion: '2.76.0' });
  assert.equal(dup.duplicate, true);
  assert.match(dup.note, /重复实例/);
  // 版本不同 → 不算重复（但也得让人看见是谁在服务）
  const mixed = selfCheck(root, { myPid: 1, myVersion: '2.77.0' });
  assert.equal(mixed.duplicate, false);
  assert.match(mixed.note, /版本是 2.77.0/);
  // 自己不算"别的实例"
  assert.equal(selfCheck(root, { myPid: 333, myVersion: '2.76.0' }).others.length, 0);
});

test('启动事实可机器读回：不受重定向日志的 GBK 乱码影响', () => {
  const root = tmp();
  recordStartup(root, { version: '2.76.0', port: 8787, ownsPort: true, duplicate: false, dreamTimerMounted: true });
  recordStartup(root, { version: '2.76.0', duplicate: true, reason: '同版本实例已在服务' });
  const recent = recentStartups(root);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].duplicate, true, '最新的在前');
  assert.equal(recent[1].dreamTimerMounted, true, '定时器挂没挂上要能查');
  assert.ok(fs.existsSync(path.join(runtimeDir(root), '启动日志.jsonl')));
});

test('登记失败也不抛：路径不可写时如实返回 ok=false', () => {
  const bad = path.join(tmp(), 'file-not-dir');
  fs.writeFileSync(bad, 'x', 'utf8');   // 让 记忆/运行时 建不出来
  const r = heartbeat(bad, { pid: 444 });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).length > 0);
});
