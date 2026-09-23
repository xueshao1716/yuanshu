import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseResumeSession } from '../../frontend/src/lib/board-home-state.mjs';

test('resume follows the latest activity rather than creation or sidebar selection', () => {
  const sessions = [
    { id: 'new', createdAt: '2026-09-22', updatedAt: '2026-09-22' },
    { id: 'resumed', createdAt: '2026-08-01', updatedAt: '2026-09-23' },
  ];
  assert.equal(chooseResumeSession(sessions).id, 'resumed');
  assert.equal(sessions[0].id, 'new');
});

test('resume tolerates missing and invalid dates without losing valid sessions', () => {
  assert.equal(chooseResumeSession([]), null);
  assert.equal(chooseResumeSession([{ id: 'bad', updatedAt: 'invalid' }, { id: 'ok', createdAt: '2026-09-01' }]).id, 'ok');
  assert.equal(chooseResumeSession([{ id: 'fallback', updatedAt: 'bad', createdAt: '2026-09-23' }, { id: 'older', createdAt: '2026-09-01' }]).id, 'fallback');
});
