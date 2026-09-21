import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactSnapshot, changedArtifact } from '../../engine/novel-run-evidence.mjs';

test('old or empty novel artifacts cannot prove this run succeeded', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-novel-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chapter.md');
  fs.writeFileSync(file, 'Old chapter content');
  const before = artifactSnapshot(file);
  assert.equal(changedArtifact(file, before).ok, false);
  fs.writeFileSync(file, '');
  assert.equal(changedArtifact(file, before).ok, false);
  fs.writeFileSync(file, 'New chapter content');
  assert.equal(changedArtifact(file, before).ok, true);
});

test('novel runner must not turn cancelled execution into success or ignore studio layers', () => {
  const source = fs.readFileSync(new URL('../../engine/workshop-novel-run.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('okHint && finishCheck'));
  assert.ok(source.includes('FOUNDATION_NODES.every'));
  assert.ok(source.includes('changedArtifact(src, before)'));
});
