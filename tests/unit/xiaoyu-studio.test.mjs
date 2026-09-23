import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENES, sceneFor, dailyIdea } from '../../frontend/src/components/xiaoyu/studio-state.mjs';

test('studio restores supported scenes and safely falls back from old preferences', () => {
  for (const scene of SCENES) assert.equal(sceneFor(scene.id), scene);
  assert.equal(sceneFor('unknown').id, 'moon');
});
test('daily inspiration is stable, local-date based, and cycles without immediate repeats', () => {
  const morning = new Date(2026, 8, 23, 1), evening = new Date(2026, 8, 23, 23);
  assert.deepEqual(dailyIdea(morning), dailyIdea(evening));
  assert.equal(dailyIdea(morning).date, '2026.09.23');
  assert.notEqual(dailyIdea(morning).title, dailyIdea(morning, 1).title);
  assert.ok(dailyIdea(morning, 10000).text);
});
