import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as probe from '../../engine/model-probe.mjs';
import { imageCandidates } from '../../engine/image-routing.mjs';

test('image family inference recognizes catalogs without the word image; Wan stays video', () => {
  for (const id of ['FLUX.1-schnell', 'doubao-seedream-4-0', 'stabilityai/stable-diffusion-xl']) {
    assert.equal(probe.modelCapabilities(id).image, true, id);
    assert.equal(probe.modelCapabilities(id).chat, false, id);
  }
  assert.equal(probe.modelCapabilities('Wan-AI/Wan2.2-T2V-A14B').video, true);
  assert.equal(probe.modelCapabilities('Wan-AI/Wan2.2-T2V-A14B').image, false);
});

test('realtime is separate from text, transcription and read-aloud', () => {
  const caps = probe.modelCapabilities('stepaudio-2.5-realtime');
  assert.equal(caps.realtime, true);
  for (const kind of ['chat', 'tts', 'asr']) assert.equal(caps[kind], false, kind);
});

test('partial and legacy capabilities fill missing flags without overriding explicit false', () => {
  assert.equal(typeof probe.effectiveCapabilities, 'function');
  assert.equal(probe.effectiveCapabilities({ id: 'flux-1', capabilities: { seed: false } }).image, true);
  assert.equal(probe.effectiveCapabilities({ id: 'flux-1', capabilities: { image: false } }).image, false);
  assert.equal(probe.effectiveCapabilities({ id: 'custom', capabilities: ['image'] }).chat, false);
});

test('image routing accepts partial snapshots but never an explicitly disabled capability', () => {
  const model = { provider: 'fixture', id: 'gpt-image-1', capabilities: { seed: false } };
  assert.deepEqual(imageCandidates([model], { provider: model.provider, modelId: model.id }), [model]);
  assert.throws(() => imageCandidates([{ ...model, capabilities: { image: false } }]), /未配置/);
});

test('media pickers bind stable model identity and block removed selections', () => {
  for (const name of ['GeneratePanel', 'VideoGeneratePanel']) {
    const text = fs.readFileSync(new URL(`../../frontend/src/components/${name}.tsx`, import.meta.url), 'utf8');
    assert.ok(!text.includes('modelIdx'), name);
    assert.ok(text.includes('useMediaModel'), name);
    assert.ok(text.includes('!selectedModel'), name);
  }
});

test('workshop text selection excludes specialized audio models', () => {
  const text = fs.readFileSync(new URL('../../frontend/src/components/WorkshopModelPicker.tsx', import.meta.url), 'utf8');
  assert.ok(text.includes('isTextModel'));
});

test('stable media choice survives reorder and fails closed after removal or disable', async () => {
  const selection = await import('../../shared/model-selection.mjs').catch(() => ({}));
  assert.equal(typeof selection.selectMediaModel, 'function');
  const a = { provider: 'p', id: 'flux-a' }, b = { provider: 'p', id: 'flux-b' };
  const key = selection.modelKey(b);
  assert.equal(selection.selectMediaModel([a, b], 'image', key), b);
  assert.equal(selection.selectMediaModel([b, a], 'image', key), b);
  assert.equal(selection.selectMediaModel([a], 'image', key), undefined);
  assert.equal(selection.selectMediaModel([a, { ...b, enabled: false }], 'image', key), undefined);
  assert.equal(selection.selectMediaModel([a, { ...b, capabilities: { image: false } }], 'image', key), undefined);
});

test('text classification excludes specialized models and honors explicit chat capability', async () => {
  const caps = await import('../../shared/model-capabilities.mjs').catch(() => ({}));
  assert.equal(typeof caps.isTextModel, 'function');
  for (const id of ['whisper-1', 'tts-1', 'stepaudio-2.5-realtime', 'flux-1']) assert.equal(caps.isTextModel({ id }), false, id);
  assert.equal(caps.isTextModel({ id: 'custom', capabilities: ['asr'] }), false);
  assert.equal(caps.isTextModel({ id: 'text', enabled: false }), false);
  assert.equal(caps.isTextModel({ id: 'custom', capabilities: { chat: true, image: true } }), true);
});
