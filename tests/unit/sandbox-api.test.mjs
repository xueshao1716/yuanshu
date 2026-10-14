import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandboxApi } from '../../engine/sandbox-api.mjs';

test('sandbox API is global: no session needed, one change applies everywhere', t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-sandbox-api-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const api = createSandboxApi({ agentDir });
  assert.equal(api.get().body.preset, 'standard');
  assert.equal(api.set({ preset: 'cautious' }).status, 200);
  assert.equal(api.get().body.preset, 'cautious');
  assert.equal(api.get().body.history[0].origin, 'api');
  assert.equal(api.set({ preset: 'trusted' }).status, 400);
  assert.match(api.set({ preset: 'trusted' }).body.error, /理由/);
  assert.equal(api.set({ sessionId: 'A', preset: 'trusted', reason: 'explicit test' }).status, 200);
  assert.equal(api.get().body.preset, 'trusted');
  for (const preset of ['hyperdimensional', '__proto__', 'constructor', {}, null]) {
    assert.equal(api.set({ preset, reason: 'test' }).status, 400);
  }
  assert.equal(api.get().body.preset, 'trusted');
});
