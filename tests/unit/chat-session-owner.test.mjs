import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionViewOwner } from '../../frontend/src/realtime/session-owner.mjs'

test('only an explicitly adopted initial session retains the mounted composer', () => {
  const owner = createSessionViewOwner(), initial = owner.keyFor(null)
  owner.adopt('created')
  assert.equal(owner.keyFor('created'), initial)
  const other = owner.keyFor('other'); assert.notEqual(other, initial)
  assert.equal(owner.keyFor('other'), other)
  assert.notEqual(owner.keyFor(null), other)
})

test('an unrelated initial selection and a later switch still remount', () => {
  const owner = createSessionViewOwner(), initial = owner.keyFor(null)
  owner.adopt('created')
  const other = owner.keyFor('other'); assert.notEqual(other, initial)
  owner.adopt('created')
  assert.notEqual(owner.keyFor('created'), other)
})
