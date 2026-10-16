import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveWorkspace } = require('../../watchdog.cjs');

// 2026-10-14 事故：watchdog 把 YUANSHU_CWD 写死成 D:\pi-workspace，在线更新重启后别人的服务换到空工作区，灵魂"丢了"。
test('watchdog 重启服务时必须沿用已有的 YUANSHU_CWD，不得换工作区', () => {
  const env = { YUANSHU_CWD: 'C:\\Users\\bob\\pi-workspace' };
  assert.equal(resolveWorkspace(env, { isDirectory: () => true, home: 'C:\\Users\\bob' }), 'C:\\Users\\bob\\pi-workspace');
});
test('没有 YUANSHU_CWD 时与服务本身的默认探测一致，而不是写死 D 盘', () => {
  const none = resolveWorkspace({}, { isDirectory: () => false, home: 'C:\\Users\\bob', platform: 'win32' });
  assert.ok(none.endsWith('yuanshu-space') && none.includes('bob'), none);
  const dev = resolveWorkspace({}, { isDirectory: p => p === 'D:\\pi-workspace', home: 'C:\\Users\\bob', platform: 'win32' });
  assert.equal(dev, 'D:\\pi-workspace');
  const legacyHome = resolveWorkspace({}, { isDirectory: p => p === 'C:\\Users\\bob\\pi-workspace', home: 'C:\\Users\\bob', platform: 'win32' });
  assert.equal(legacyHome, 'C:\\Users\\bob\\pi-workspace');
});
test('watchdog 源码不再硬编码工作区', () => {
  const src = fs.readFileSync(new URL('../../watchdog.cjs', import.meta.url), 'utf8');
  assert.ok(!/YUANSHU_CWD:\s*'D:/.test(src));
});
