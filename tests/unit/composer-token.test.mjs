import test from 'node:test';
import assert from 'node:assert/strict';
import * as tokens from '../../frontend/src/lib/composer-token.mjs';

test('composer recognizes commands and mentions at the caret, including fullwidth input', () => {
  assert.deepEqual(tokens.composerToken('/he'), { kind: 'slash', query: '/he', start: 0, end: 3 });
  assert.deepEqual(tokens.composerToken('  ／he'), { kind: 'slash', query: '/he', start: 2, end: 5 });
  assert.deepEqual(tokens.composerToken('看看＠文档 然后说', 5), { kind: 'at', query: '文档', start: 2, end: 5 });
  assert.equal(tokens.composerToken('hello@example.com'), null);
  assert.equal(tokens.composerToken('https://a/b'), null);
  assert.equal(tokens.composerToken('@notes', 2, 5), null);
});
test('selecting a reference removes only its active token', () => {
  const value = '请参考 @notes 然后解释';
  assert.equal(tokens.removeComposerToken(value, tokens.composerToken(value, 10)), '请参考  然后解释');
});
