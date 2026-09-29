import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as manager from '../../engine/session-manager.mjs'
import { originFixture, makeLink } from '../helpers/session-origin-fixture.mjs'

const access = id => {
  assert.equal(typeof manager.canAccessSessionOrigin, 'function', 'read-only origin authorization must exist')
  return manager.canAccessSessionOrigin(id)
}

test('persisted origin authorization is synchronous, fresh, and side-effect free', t => {
  const f = originFixture(t), bytes = fs.readFileSync(f.file), before = fs.statSync(f.file)
  f.active.set(f.id, { sm: f.origin, agent: { dispose() { f.effects.disposed++ } }, busy: true })
  for (let i = 0; i < 3; i++) assert.equal(access(f.id), true)
  assert.deepEqual(fs.readFileSync(f.file), bytes)
  assert.equal(fs.statSync(f.file).mtimeMs, before.mtimeMs)
  assert.deepEqual(f.effects, { opens: 0, agents: 0, disposed: 0 })
  assert.ok(f.active.has(f.id))
  // Cached scan still identifies it, but fresh header must no longer authorize it.
  fs.writeFileSync(f.file, JSON.stringify({ ...f.header, cwd: f.root }) + '\n')
  assert.equal(access(f.id), false)
})

test('persisted origins can be authorized without opening an SDK manager', t => {
  const f = originFixture(t)
  assert.equal(access(f.id), true)
  assert.equal(f.effects.opens, 0)
  f.write([{ ...f.header, version: undefined }])
  assert.equal(access(f.id), true, 'valid legacy headers remain usable')
})

for (const [label, mutate] of [
  ['headerless', f => [{ type: 'message', message: { role: 'user', content: 'no header' } }]],
  ['different identity', f => [{ ...f.header, id: 'different-id' }]],
  ['relative cwd', f => [{ ...f.header, cwd: 'workspace' }]],
  ['blank cwd', f => [{ ...f.header, cwd: '' }]],
  ['wrong cwd', f => [{ ...f.header, cwd: f.root }]],
  ['invalid timestamp', f => [{ ...f.header, timestamp: 'not-a-date' }]],
  ['invalid version', f => [{ ...f.header, version: '3' }]],
  ['duplicate header', f => [f.header, f.header]],
  ['mismatched later header', f => [f.header, { ...f.header, id: 'other' }]],
  ['worker marker', f => [f.header, { type: 'custom', customType: 'voice-task-origin', data: {} }]],
  ['nonobject entry', f => [f.header, null]],
]) test(`origin authorization rejects ${label} without touching history`, t => {
  const f = originFixture(t)
  f.active.set(f.id, { sm: f.origin })
  f.write(mutate(f)); const bytes = fs.readFileSync(f.file)
  assert.equal(access(f.id), false)
  assert.deepEqual(manager.withIdleSession(f.id, () => assert.fail('must not append')), { code: 'conversation_gone' })
  assert.deepEqual(fs.readFileSync(f.file), bytes)
  assert.equal(f.effects.opens, 0)
})

test('malformed JSON and a deleted cached origin fail closed without reconstruction', t => {
  const f = originFixture(t)
  assert.equal(access(f.id), true)
  fs.appendFileSync(f.file, '{bad json}\n')
  assert.equal(access(f.id), false)
  fs.unlinkSync(f.file)
  assert.equal(access(f.id), false)
  assert.deepEqual(manager.withIdleSession(f.id, () => assert.fail('must not append')), { code: 'conversation_gone' })
  assert.equal(fs.existsSync(f.file), false)
  assert.equal(f.effects.opens, 0)
})

for (const location of ['sibling', '.trash', 'nested']) test(`scanner or live manager cannot authorize a ${location} file`, t => {
  const f = originFixture(t)
  const dir = location === 'sibling' ? path.join(path.dirname(f.sessionsDir), 'other') : path.join(f.sessionsDir, location)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, path.basename(f.file)); fs.renameSync(f.file, target)
  f.origin.sessionFile = target
  f.active.set(f.id, { sm: f.origin })
  assert.equal(access(f.id), false)
  assert.deepEqual(manager.withIdleSession(f.id, () => assert.fail('must not append')), { code: 'conversation_gone' })
  f.active.clear(); assert.equal(access(f.id), false)
})

for (const id of ['', ' ', '../escape', 'a/b', 'a\\b', null, {}, 'x\0y']) test(`malformed origin id is denied: ${JSON.stringify(id)}`, t => {
  originFixture(t); assert.equal(access(id), false)
})

for (const field of ['cwd', 'sessionsDir']) for (const value of ['', 'relative']) test(`configured ${field} must be absolute: ${value}`, t => {
  const f = originFixture(t); f.configure({ [field]: value }); assert.equal(access(f.id), false)
})

for (const field of ['sessionId', 'cwd', 'sessionFile']) test(`active manager ${field} must match disk identity`, t => {
  const f = originFixture(t)
  f.active.set(f.id, { sm: f.origin })
  f.origin[field] = field === 'sessionId' ? 'wrong' : field === 'cwd' ? f.root : path.join(f.sessionsDir, 'missing.jsonl')
  assert.equal(access(f.id), false)
  assert.deepEqual(manager.withIdleSession(f.id, () => assert.fail('must not append')), { code: 'conversation_gone' })
})

for (const file of ['relative', 'traversal']) test(`active session rejects ${file} file path`, t => {
  const f = originFixture(t)
  f.origin.sessionFile = file === 'relative' ? 'sessions/' + path.basename(f.file) : f.sessionsDir + path.sep + '..' + path.sep + 'workspace' + path.sep + path.basename(f.file)
  f.active.set(f.id, { sm: f.origin }); assert.equal(access(f.id), false)
})

test('a hard-linked origin is never authorized', t => {
  const f = originFixture(t)
  fs.linkSync(f.file, path.join(f.root, 'second-link.jsonl'))
  assert.equal(access(f.id), false)
})

test('a symbolic-link origin is never authorized', t => {
  const f = originFixture(t), target = path.join(f.root, 'target.jsonl')
  fs.renameSync(f.file, target)
  if (!makeLink(t, target, f.file, 'file')) return
  try { assert.equal(access(f.id), false) } finally { fs.unlinkSync(f.file) }
})

test('junction ancestors of the sessions root are rejected', t => {
  const f = originFixture(t), target = path.join(f.root, 'relocated-sessions'), original = path.dirname(f.sessionsDir)
  fs.renameSync(original, target)
  if (!makeLink(t, target, original, 'junction')) return
  try { assert.equal(access(f.id), false) } finally { fs.unlinkSync(original) }
})

test('a linked configured workspace cannot authorize its origin', t => {
  const f = originFixture(t), target = path.join(f.root, 'relocated-workspace')
  fs.renameSync(f.cwd, target)
  if (!makeLink(t, target, f.cwd, 'junction')) return
  try { assert.equal(access(f.id), false) } finally { fs.unlinkSync(f.cwd) }
})

test('forward slash roots remain valid without bypassing ancestor link checks', t => {
  const f = originFixture(t), slash = value => value.replaceAll('\\', '/')
  f.configure({ sessionsDir: slash(f.sessionsDir), cwd: slash(f.cwd) })
  assert.equal(access(f.id), true)
  const target = path.join(f.root, 'relocated-forward'), original = path.dirname(f.sessionsDir)
  fs.renameSync(original, target)
  if (!makeLink(t, target, original, 'junction')) return
  try { assert.equal(access(f.id), false) } finally { fs.unlinkSync(original) }
})
