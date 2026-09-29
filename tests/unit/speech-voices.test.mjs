import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

async function setup() {
  const url = new URL('../../frontend/src/lib/speech-voices.mjs', import.meta.url);
  assert.ok(fs.existsSync(url), 'installed device voice preferences are implemented');
  const { createDeviceVoices } = await import(url.href);
  let installed = [], listener, saved = 'voice-b', changes = 0;
  const synth = { getVoices: () => installed,
    addEventListener(type, fn) { assert.equal(type, 'voiceschanged'); listener = fn; },
    removeEventListener(type, fn) { assert.equal(fn, listener); listener = null; } };
  const storage = { getItem: () => saved, setItem(key, value) { assert.equal(key, 'yuanshu_speech_voice'); saved = value; } };
  const store = createDeviceVoices({ synth, storage });
  return { store, synth, install(voices) { installed = voices; listener?.(); }, saved: () => saved,
    listen: () => store.subscribe(() => changes++), changes: () => changes, listener: () => listener };
}

test('voices arriving asynchronously restore a known preference and deduplicate voice IDs', async () => {
  const f = await setup(), off = f.listen();
  assert.deepEqual(f.store.getSnapshot(), { voices: [], selected: '' });
  const a = { voiceURI: 'voice-a', name: '小晓', lang: 'zh-CN' }, b = { voiceURI: 'voice-b', name: '小云', lang: 'zh-TW' };
  f.install([a, b, b]);
  assert.equal(f.store.getSnapshot().voices.length, 2);
  assert.equal(f.store.getSnapshot().selected, 'voice-b');
  assert.equal(f.store.getVoice(), b);
  const stable = f.store.getSnapshot(); f.install([a, b]);
  assert.equal(f.store.getSnapshot(), stable, 'unchanged voices keep an external-store-stable snapshot');
  assert.equal(f.store.select('unknown'), false);
  assert.equal(f.store.select('voice-a'), true);
  assert.equal(f.saved(), 'voice-a');
  f.install([b]);
  assert.equal(f.store.getSnapshot().selected, '');
  assert.equal(f.store.getVoice(), null);
  off(); assert.equal(f.listener(), null);
});

test('default voice, late changes while settings are closed and unavailable storage are safe', async () => {
  const f = await setup();
  const a = { name: '系统中文', lang: 'zh-CN' };
  f.install([a]);
  const off = f.listen();
  assert.equal(f.store.getSnapshot().voices.length, 1);
  assert.ok(f.store.select(f.store.getSnapshot().voices[0].id));
  assert.equal(f.store.getVoice(), a);
  assert.ok(f.store.select('')); assert.equal(f.saved(), ''); assert.equal(f.store.getVoice(), null);
  off();
  const { createDeviceVoices } = await import('../../frontend/src/lib/speech-voices.mjs');
  const empty = createDeviceVoices({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  assert.equal(empty.select(''), true); assert.equal(empty.getVoice(), null);
  empty.subscribe(() => {})();
});
