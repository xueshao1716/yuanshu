import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestApk, compareVersions } from '../../engine/app-release.mjs';

test('手机端新版本：按版本号（不是字典序）挑最新的 APK，忽略别的文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-'));
  for (const n of ['元枢-v2.84.9-arm64.apk', '元枢-v2.224.0-arm64.apk', '元枢-v2.223.1-arm64.apk', '元枢-v9.9.9-arm64.apk.idsig', '元枢-v3.0.0-x64.exe']) fs.writeFileSync(path.join(dir, n), 'x');
  fs.writeFileSync(path.join(dir, '元枢-v2.300.0-arm64.apk'), ''); // 空文件（还在复制）不算
  const r = latestApk(dir);
  assert.equal(r.version, '2.224.0');
  assert.equal(r.name, '元枢-v2.224.0-arm64.apk');
  assert.equal(latestApk(path.join(dir, 'nope')), null);
  assert.ok(compareVersions('2.224.0', '2.84.9') > 0);
  assert.equal(compareVersions('2.224.0', '2.224.0'), 0);
});
