import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { initMemorySync, syncMemoryToTui } from '../../engine/memory-sync.mjs';

test('source-only edits and atomic replacement refresh generated TUI memory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-memory-watch-'));
  t.after(() => { initMemorySync({ wsRoot: root }); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, '工程/经验库/experience.md');
  const out = path.join(root, '.pi/APPEND_SYSTEM.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '### 2026-09-28\n📌 old rule');
  initMemorySync({ wsRoot: root, watch: true, interval: 20 });
  assert.ok(fs.existsSync(out), 'startup must synchronize');
  const waitFor = async text => {
    for (let i = 0; i < 75; i++) {
      if (fs.readFileSync(out, 'utf8').includes(text)) return;
      await pause(20);
    }
    assert.fail('source change was not propagated: ' + text);
  };
  fs.writeFileSync(source, '### 2026-09-29\n📌 latest identity rule');
  await waitFor('latest identity rule');
  fs.writeFileSync(source + '.next', '### 2026-09-29\n📌 atomic replacement rule');
  fs.renameSync(source + '.next', source);
  await waitFor('atomic replacement rule');
});
test('unchanged sync is idempotent and does not churn the generated file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-memory-stable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initMemorySync({ wsRoot: root });
  assert.equal(syncMemoryToTui(), true);
  const file = path.join(root, '.pi/APPEND_SYSTEM.md');
  fs.utimesSync(file, 1000000, 1000000);
  const before = fs.statSync(file).mtimeMs;
  assert.equal(syncMemoryToTui(), true);
  assert.equal(fs.statSync(file).mtimeMs, before);
});
