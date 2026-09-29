import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as manager from '../../engine/session-manager.mjs'
import { originFixture, makeLink } from '../helpers/session-origin-fixture.mjs'

const access = id => {
  assert.equal(typeof manager.canAccessSessionOrigin, 'function')
  return manager.canAccessSessionOrigin(id)
}

test('only the genuine active SDK-like lazy session can authorize an unpersisted origin', async t => {
  const f = originFixture(t, { lazy: true }), id = await manager.createSession('lazy')
  const entry = f.active.get(id), file = entry.sm.getSessionFile(), effects = { ...f.effects }
  assert.equal(access(id), true)
  assert.equal(access(id), true)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(f.effects, effects)
  f.active.delete(id); assert.equal(access(id), false)
  f.active.set(id, entry); f.active.set('wrong', entry)
  assert.equal(access('wrong'), false)
  await manager.deleteSession(id)
  f.active.set(id, entry); assert.equal(access(id), false)
  assert.equal(fs.existsSync(file), false)
})

for (const change of ['worker', 'headerless', 'header mismatch', 'flushed', 'wrong cwd', 'duplicate header', 'relative file']) test(`lazy authorization rejects ${change}`, async t => {
  const f = originFixture(t, { lazy: true }), id = await manager.createSession('lazy')
  const sm = f.active.get(id).sm
  if (change === 'worker') sm.fileEntries.push({ type: 'custom', customType: 'voice-task-origin', data: {} })
  if (change === 'headerless') sm.fileEntries.shift()
  if (change === 'header mismatch') sm.fileEntries[0].id = 'wrong'
  if (change === 'flushed') sm.flushed = true
  if (change === 'wrong cwd') sm.cwd = f.root
  if (change === 'duplicate header') sm.fileEntries.push({ ...sm.fileEntries[0] })
  if (change === 'relative file') sm.sessionFile = 'sessions/' + path.basename(sm.sessionFile)
  assert.equal(access(id), false)
  assert.deepEqual(manager.withIdleSession(id, () => assert.fail('must not append')), { code: 'conversation_gone' })
})

test('unregistered in-memory headers do not confer lazy authority', t => {
  const f = originFixture(t)
  f.origin.fileEntries = [f.header]; f.origin.flushed = false
  fs.unlinkSync(f.file); f.active.set(f.id, { sm: f.origin })
  assert.equal(access(f.id), false)
})

for (const boundary of ['access', 'append']) test(`persisted file disappearing during ${boundary} cannot borrow lazy authority`, t => {
  const f = originFixture(t)
  f.origin.fileEntries = [f.header]; f.origin.flushed = false
  f.origin.getCwd = () => {
    if (fs.existsSync(f.file)) fs.unlinkSync(f.file)
    return f.cwd
  }
  f.active.set(f.id, { sm: f.origin })
  if (boundary === 'access') assert.equal(access(f.id), false)
  else assert.deepEqual(manager.withIdleSession(f.id, () => assert.fail('must not append')), { code: 'conversation_gone' })
  assert.equal(fs.existsSync(f.file), false)
})

for (const header of [null, undefined]) test(`lazy header accessor cannot contradict complete rows with ${header}`, async t => {
  const f = originFixture(t, { lazy: true }), id = await manager.createSession('lazy')
  f.active.get(id).sm.getHeader = () => header
  assert.equal(access(id), false)
  assert.deepEqual(manager.withIdleSession(id, () => assert.fail('must not append')), { code: 'conversation_gone' })
})

test('observing first persistence permanently revokes lazy file absence allowance', async t => {
  const f = originFixture(t, { lazy: true }), id = await manager.createSession('lazy'), sm = f.active.get(id).sm
  assert.equal(access(id), true)
  fs.writeFileSync(sm.getSessionFile(), sm.fileEntries.map(JSON.stringify).join('\n') + '\n')
  assert.equal(access(id), true)
  fs.unlinkSync(sm.getSessionFile())
  assert.equal(access(id), false)
})

test('lazy origins also validate canonical root ancestors before the file exists', async t => {
  const f = originFixture(t, { lazy: true }), id = await manager.createSession('lazy')
  const target = path.join(f.root, 'relocated'), original = path.dirname(f.sessionsDir)
  fs.renameSync(original, target)
  if (!makeLink(t, target, original, 'junction')) return
  try { assert.equal(access(id), false) } finally { fs.unlinkSync(original) }
})

for (const change of ['delete', 'worker', 'identity', 'active entry replaced']) test(`idle append revalidates after SDK opening: ${change}`, t => {
  const f = originFixture(t, { onOpen({ sm, active, file, id }) {
    if (change === 'delete') fs.unlinkSync(file)
    if (change === 'worker') fs.appendFileSync(file, JSON.stringify({ type: 'custom', customType: 'voice-task-origin' }) + '\n')
    if (change === 'identity') sm.sessionId = 'wrong'
    if (change === 'active entry replaced') active.set(id, { sm, busy: true })
  } })
  assert.deepEqual(manager.withIdleSession(f.id, () => assert.fail('must not append')), { code: 'conversation_gone' })
  assert.equal(f.effects.opens, 1)
  if (change === 'delete') assert.equal(fs.existsSync(f.file), false)
})

test('denied authorization neither evicts nor disposes an existing live agent', t => {
  const f = originFixture(t), entry = { sm: f.origin, agent: { dispose() { assert.fail('must not dispose') } } }
  f.active.set(f.id, entry)
  f.write([f.header, { type: 'custom', customType: 'voice-task-origin' }])
  assert.equal(access(f.id), false)
  assert.deepEqual(manager.withIdleSession(f.id, () => assert.fail('must not append')), { code: 'conversation_gone' })
  assert.equal(f.active.get(f.id), entry)
})
