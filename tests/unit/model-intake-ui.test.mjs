import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = file => fs.existsSync(new URL('../../frontend/src/' + file, import.meta.url)) ? fs.readFileSync(new URL('../../frontend/src/' + file, import.meta.url), 'utf8') : '';
test('model manager shares channel intake and propagates global refresh', () => {
  assert.ok(read('components/ModelManager.tsx').split('\n').some(l => l.includes('<ModelChannels')));
  assert.ok(read('components/ModelChannels.tsx').split('\n').some(l => l.includes('await refreshModels()')));
});
test('onboarding offers protocol, manual IDs, preview and accessible errors', () => {
  const text = read('components/models/ModelConnectionForm.tsx');
  for (const word of ['anthropic-messages', 'modelIds', 'KeysApi.discover', 'role="alert"', 'disabled={busy}']) assert.ok(text.includes(word), word);
});
test('model verification is explicit and configured counts never promise availability', () => {
  const hub = read('pages/ModelHub.tsx');
  assert.ok(hub.includes('KeysApi.verify'));
  assert.ok(!hub.includes('个可用模型'));
  assert.ok(read('components/models/ModelCard.tsx').includes('验证文本'));
});
