import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

// 2026-11-20 真假李鬼：安装版服务抢了 8787，开发仓库没起来，/api/health 照样 200，重启脚本报「就绪」。
// 三处必须同算法：server.mjs 报指纹、restart-pi-web.ps1 和 release-restart.mjs 比对指纹。
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('/api/health 带版本和实例指纹，指纹=代码目录小写的 sha256 前 12 位', () => {
  const s = read('server.mjs');
  assert.match(s, /APP_DIR_ID = crypto\.createHash\("sha256"\)\.update\(__dirname\.toLowerCase\(\)\)\.digest\("hex"\)\.slice\(0, 12\)/);
  assert.match(s, /"\/api\/health", \(res\) => json\(res, 200, \{ ok: true, version: APP_VERSION, instance: APP_DIR_ID \}\)/);
  assert.equal(crypto.createHash('sha256').update('d:\pi-web').digest('hex').slice(0, 12), 'b4ca2c87525b');
});

test('重启脚本不再只看 200：指纹对不上就报另一份元枢在响应', () => {
  const ps = read('scripts/restart-pi-web.ps1');
  assert.match(ps, /\$root\.ToLower\(\)/);
  assert.match(ps, /\$body\.instance -eq \$expectedId/);
  assert.match(ps, /正在响应的是另一份元枢/);
  const rr = read('scripts/release-restart.mjs');
  assert.match(rr, /body\.instance === EXPECTED_ID/);
});
