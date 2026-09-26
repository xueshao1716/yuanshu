import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = file => fs.readFileSync(new URL(`../../frontend/src/${file}`, import.meta.url), 'utf8');

test('execution visibility leaves delivery, failures and workflow outside the hidden region', () => {
  const src = read('components/Message.tsx');
  assert.ok(src.includes('ProcessVisibilityToggle'), 'missing one-click tool visibility');
  const start = src.indexOf('data-tool-details');
  const end = src.indexOf('</div>', start);
  assert.ok(start > 0);
  assert.ok(src.slice(start, end).includes('ToolCard'));
  for (const content of ['<Attachments', '{msg.error ?', '{msg.truncated ?']) assert.ok(src.indexOf(content, start) > end, content);
  assert.ok(src.includes('failedTools'), 'hidden failures need a visible summary');
  assert.ok(src.includes('aria-expanded={open}'), 'individual tools must be keyboard accessible');
});

test('evidence shares remembered preference without hiding issues or next steps', () => {
  const src = read('components/WorkExplanation.tsx');
  assert.ok(src.includes("useProcessVisibility('evidence')"));
  assert.ok(src.includes('open={showEvidence}'));
  assert.ok(src.includes('event.preventDefault()'));
  assert.ok(src.indexOf('{work.problem') < src.indexOf('<details'));
  assert.ok(src.indexOf('{work.nextStep}') > src.indexOf('</details>'));
});
