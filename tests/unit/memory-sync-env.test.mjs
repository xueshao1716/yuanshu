import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('记忆同步优先使用 YUANSHU_CWD，不写入旧工作区', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-memory-env-'));
  const current = path.join(root, 'current');
  const legacy = path.join(root, 'legacy');
  try {
    const moduleUrl = new URL('../../engine/memory-sync.mjs', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `const {syncMemoryToTui}=await import(${JSON.stringify(moduleUrl)}); if (!syncMemoryToTui()) process.exit(1);`], {
      env: { ...process.env, YUANSHU_CWD: current, PI_WEB_CWD: legacy, MEMORY_SYNC_RUN: '' },
    });
    assert.ok(fs.existsSync(path.join(current, '.pi', 'APPEND_SYSTEM.md')));
    assert.ok(!fs.existsSync(legacy));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
