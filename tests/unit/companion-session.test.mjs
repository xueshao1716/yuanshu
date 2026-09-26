import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionSessionReader } from '../../engine/companion-session.mjs';
test('session reader uses registered model and current branch without opening an agent', () => {
  const active = new Map([['a', { modelKey: { provider: 'p', id: 'one' }, sm: { fileEntries: [{ id: 'm1' }], getLeafId: () => 'm1' } }]]);
  const read = createCompanionSessionReader({ activeSessions: active, findSession: () => null,
    readEntriesFromFile: () => { throw Error('no file'); }, resolveLeafId: () => 'm1',
    extractMessages: (entries, leaf) => { assert.equal(leaf, 'm1'); return [{ role: 'user', text: 'mine' }]; },
    getModels: () => [{ provider: 'p', id: 'one' }], getDefaultModel: () => ({ provider: 'p', id: 'one' }) });
  assert.deepEqual(read('a').messages, [{ role: 'user', content: 'mine' }]);
  assert.equal(read('missing'), null);
  const revision = read('a').revision;
  active.get('a').sm.fileEntries.push({ id: 'm2' });
  assert.notEqual(read('a').revision, revision);
  active.get('a').modelKey = { provider: 'unregistered', id: 'arbitrary' };
  assert.equal(read('a'), null);
});
test('inactive session resolves its model on the selected branch, not the last sibling', () => {
  const entries = [{ id: 'root', type: 'model_change', provider: 'p', modelId: 'one' },
    { id: 'mine', parentId: 'root', type: 'message' },
    { id: 'sibling', parentId: 'root', type: 'model_change', provider: 'p', modelId: 'two' }];
  const read = createCompanionSessionReader({ activeSessions: new Map(), findSession: () => ({ file: 'fixture' }),
    readEntriesFromFile: () => entries, resolveLeafId: () => 'mine', extractMessages: () => [],
    getModels: () => ['one', 'two'].map(id => ({ provider: 'p', id })), getDefaultModel: () => ({ provider: 'p', id: 'two' }) });
  assert.equal(read('mine').model.id, 'one');
});
