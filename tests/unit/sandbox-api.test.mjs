import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandboxApi } from '../../engine/sandbox-api.mjs';

test('sandbox API requires explicit existing sessions and isolates changes', t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-sandbox-api-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const api = createSandboxApi({ agentDir, sessionExists: id => ['A', 'B'].includes(id) });
  for (const id of [undefined, null, '', ' ', 3, {}, []]) assert.equal(api.get(id).status, 400);
  assert.equal(api.get('missing').status, 404);
  assert.equal(api.set({ preset: 'trusted', reason: 'test' }).status, 400);
  assert.equal(api.set({ sessionId: 'missing', preset: 'cautious' }).status, 404);
  assert.equal(api.set({ sessionId: 'A', preset: 'cautious', origin: 'human' }).status, 200);
  assert.equal(api.get('A').body.preset, 'cautious');
  assert.equal(api.get('B').body.preset, 'standard');
  assert.equal(api.get('A').body.history[0].origin, 'api');
  assert.equal(api.set({ sessionId: 'A', preset: 'trusted' }).status, 400);
  assert.match(api.set({ sessionId: 'A', preset: 'trusted' }).body.error, /理由/);
  assert.equal(api.set({ sessionId: 'A', preset: 'trusted', reason: 'explicit test' }).status, 200);
  for (const preset of ['hyperdimensional', '__proto__', 'constructor', {}, null]) {
    assert.equal(api.set({ sessionId: 'B', preset, reason: 'test' }).status, 400);
  }
  assert.equal(api.get('B').body.preset, 'standard');
});
