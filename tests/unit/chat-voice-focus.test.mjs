import test from 'node:test'
import assert from 'node:assert/strict'
import { createAudioFocus } from '../../frontend/src/realtime/focus.mjs'
test('recorder cleanup cannot release realtime ownership and speech stays blocked', () => {
  const f = createAudioFocus(); let changed = 0; const off = f.subscribe(() => changed++)
  assert.equal(f.acquireCall(), true); f.setRecorder(false); assert.equal(f.isBusy(), true)
  assert.equal(f.acquireCall(), false); f.releaseCall(); f.setRecorder(true)
  assert.equal(f.acquireCall(), false); f.setRecorder(false); assert.equal(f.isBusy(), false)
  off(); assert.ok(changed >= 4)
})
