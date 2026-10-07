import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldRunMain } = require('../../watchdog.cjs');

// 2026-10-07 真机：安装版 launcher/service.cjs 用 require 加载 watchdog，require.main 不是 watchdog，
// 守护从未启动，在线更新退出后服务再也起不来。
test('watchdog starts when run directly or loaded by the installed launcher, not when imported elsewhere', () => {
  const self = { filename: 'D:/pi-web/watchdog.cjs' };
  assert.equal(shouldRunMain(self, self), true);
  assert.equal(shouldRunMain({ filename: 'C:\\Program Files\\元枢\\launcher\\service.cjs' }, self), true);
  assert.equal(shouldRunMain({ filename: 'D:/yuanshu/Launcher/Service.cjs' }, self), true);
  assert.equal(shouldRunMain({ filename: 'D:/pi-web/tests/unit/x.test.cjs' }, self), false);
  assert.equal(shouldRunMain({ filename: 'D:/x/my-service.cjs' }, self), false);
  assert.equal(shouldRunMain(undefined, self), false);
});

test('watchdog really runs main() when required from a launcher/service.cjs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-launch-'));
  try {
    fs.mkdirSync(path.join(dir, 'app', 'lib'), { recursive: true }); fs.mkdirSync(path.join(dir, 'launcher'));
    fs.copyFileSync(new URL('../../lib/service-readiness.cjs', import.meta.url), path.join(dir, 'app', 'lib', 'service-readiness.cjs'));
    const src = fs.readFileSync(new URL('../../watchdog.cjs', import.meta.url), 'utf8')
      // 只验证 main 被调用：把 main 换成写标记后退出，不碰真实端口和服务
      .replace(/async function main\(\) \{/, 'async function main() { require("fs").writeFileSync(require("path").join(__dirname, "ran"), "1"); process.exit(0);');
    fs.writeFileSync(path.join(dir, 'app', 'watchdog.cjs'), src);
    fs.writeFileSync(path.join(dir, 'launcher', 'service.cjs'), 'require(require("path").join(__dirname, "..", "app", "watchdog.cjs"));\n');
    const r = spawnSync(process.execPath, [path.join(dir, 'launcher', 'service.cjs')], { cwd: path.join(dir, 'app'), timeout: 15000 });
    assert.equal(r.status, 0, String(r.stderr));
    assert.ok(fs.existsSync(path.join(dir, 'app', 'ran')), 'main() ran under the launcher');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
