import test from 'node:test'
import assert from 'node:assert/strict'
import { originFixture } from '../helpers/session-origin-fixture.mjs'

test('fallback SDK supports persistent task receipts and preserves header identity', t => {
  const f = originFixture(t)
  assert.equal(typeof f.origin.appendCustomEntry, 'function')
  f.origin.appendCustomEntry('voice-task-delivery', { deliveryId: 'receipt' })
  assert.equal(f.origin.getFileEntries().at(-1).customType, 'voice-task-delivery')
})
