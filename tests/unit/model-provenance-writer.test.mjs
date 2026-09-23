import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withModelProvenance } from '../../engine/model-provenance-writer.mjs';

test('selected model is not an answer; done retains the last successful replacement', () => {
  const events = [], requested = { provider: 'p', id: 'flagship' }, replacement = { provider: 'q', id: 'backup' };
  const writer = withModelProvenance({ push: (type, data) => events.push({ type, data }) }, requested);
  writer.push('model_selected', { model: requested }); writer.push('done', {});
  assert.equal(events.at(-1).data.model, null);
  writer.push('model_used', { model: requested });
  writer.push('model_switched', { ...replacement, reason: 'empty' }); writer.push('done', {});
  assert.deepEqual(events.at(-1).data.model, replacement);
  assert.deepEqual(events.at(-1).data.requestedModel, requested);
  writer.push('done', { model: null });
  assert.equal(events.at(-1).data.model, null, 'media-only completion does not invent a text model');
});
