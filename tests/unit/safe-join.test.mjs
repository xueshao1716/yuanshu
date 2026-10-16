import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { safeJoin } from '../../engine/tools/security.mjs';

const root = path.resolve(os.tmpdir(), 'yuanshu-safe-join-root');

test('资产库文件地址带的是工作空间内的绝对路径：原样采用（Linux 下不能被去前导斜杠拼成 root/home/...）', () => {
  const abs = path.join(root, '生成物', 'image', 'a.png');
  assert.equal(safeJoin(root, abs), abs);
  assert.equal(safeJoin(root, root), root);
});

test('相对路径与 ../ 越权、工作空间外的绝对路径仍然被限制在 root 内或拒绝', () => {
  assert.equal(safeJoin(root, '生成物/a.png'), path.join(root, '生成物', 'a.png'));
  assert.equal(safeJoin(root, '../outside.txt'), null);
  const outside = path.resolve(os.tmpdir(), 'elsewhere', 'x.txt');
  const r = safeJoin(root, outside);
  assert.ok(r === null || r.startsWith(root + path.sep), String(r));
});
