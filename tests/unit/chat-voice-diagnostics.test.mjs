import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const module = await import('../../engine/chat-voice-diagnostics.mjs').catch(() => ({}))

test('call diagnostics are bounded metadata only, survive recreation, and never break a call', t => {
  assert.equal(typeof module.createVoiceDiagnostics, 'function')
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-call-diagnostics-'))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const write = module.createVoiceDiagnostics({ rootDir })
  for (let i = 0; i < 210; i++) write({ event: 'ended', stage: 'ready', code: 'provider_disconnected', elapsedMs: i,
    audio: 'private-audio', token: 'private-token', context: 'private-history', message: 'private-error' })
  const file = path.join(rootDir, 'voice-calls', 'diagnostics.json')
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(rows.length, 200); assert.equal(rows[0].elapsedMs, 10)
  assert.doesNotMatch(JSON.stringify(rows), /private-/)
  assert.equal(rows.at(-1).code, 'provider_disconnected')
  module.createVoiceDiagnostics({ rootDir })({ event: 'ready', stage: 'ready', elapsedMs: 300 })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).at(-1).event, 'ready')
  assert.doesNotThrow(() => module.createVoiceDiagnostics({ rootDir: file })({ event: 'ready', stage: 'ready' }))
})
