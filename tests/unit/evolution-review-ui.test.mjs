import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = name => fs.readFileSync(new URL(`../../frontend/src/${name}`, import.meta.url), 'utf8');

test('prompt comparison requires explicit per-case human review and resets for new evaluation', () => {
  const review = source('components/EvolutionReview.tsx'), page = source('pages/Apps.tsx');
  for (const text of ['useState<string[]>([])', 'evaluation.questions.every', "comparisons.includes('better')", '!!note.trim()',
    'evaluationId: evaluation.id', 'disabled={!ready || busy}', 'fieldset disabled={busy}', 'grid-cols-1 md:grid-cols-2', '不代表独立验证']) {
    assert.ok(review.includes(text), text);
  }
  assert.ok(page.split('\n').some(line => line.includes('<EvolutionReview') && line.includes('key={`${it.evaluation.id}-${vi}`}')));
  assert.ok(page.includes('refreshInterval:'));
  assert.ok(page.includes('评测未完成：'));
  assert.ok(!page.includes('it.evaluation.best'));
  assert.ok(!page.includes('setInterval('));
});
