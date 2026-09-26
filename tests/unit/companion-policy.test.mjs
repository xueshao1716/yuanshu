import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCompanionOutput } from '../../engine/companion-policy.mjs';
const facts = { evidenceIds: ['run:1'] };
const output = { action: 'resting', expression: 'calm', utterance: '安静待一会。', reason: '用户请求', evidenceIds: ['run:1'], durationMs: 10000, shouldInterrupt: false };
const json = JSON.stringify(output);
test('one complete JSON code fence is only a transport wrapper', () => {
  assert.deepEqual(validateCompanionOutput('```json\n' + json + '\n```', facts), output);
  assert.deepEqual(validateCompanionOutput(' \n```\n' + json + '\n```\n ', facts), output);
});
test('fence normalization never accepts prose, multiple blocks, invalid fields or fabricated evidence', () => {
  for (const text of ['Here is JSON:\n```json\n' + json + '\n```', '```json\n' + json + '\n```\nextra',
    '```json\n' + json + '\n```\n```json\n' + json + '\n```', '```js\n' + json + '\n```',
    '```json\n' + json, JSON.stringify({ ...output, tool: 'shell' }),
    '```json\n' + JSON.stringify({ ...output, evidenceIds: ['other-session'] }) + '\n```']) {
    assert.equal(validateCompanionOutput(text, facts), null);
  }
});
