import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectArtifactBytes, summarizeObjective } from '../../engine/task-evidence-objective.mjs';

test('bounded structural checks state their actual scope', () => {
  assert.equal(inspectArtifactBytes('a.json', Buffer.from('{}')).status, 'PASS');
  assert.equal(inspectArtifactBytes('a.json', Buffer.from('{')).status, 'FAIL');
  assert.equal(inspectArtifactBytes('a.html', Buffer.from('<html>')).status, 'UNVERIFIED');
  assert.equal(inspectArtifactBytes('a.txt', Buffer.alloc(0)).status, 'FAIL');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64');
  const result = inspectArtifactBytes('a.png', png);
  assert.equal(result.status, 'PASS');
  assert.equal(result.scope, 'image-header');
  assert.equal(result.width, 1);
  assert.equal(inspectArtifactBytes('a.jpg', png).status, 'FAIL');
  assert.equal(summarizeObjective([]).status, 'UNVERIFIED');
  assert.equal(summarizeObjective([{ objective: result }, { objective: { status: 'UNVERIFIED' } }]).status, 'UNVERIFIED');
});
