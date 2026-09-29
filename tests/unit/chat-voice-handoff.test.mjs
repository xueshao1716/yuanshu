import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('main chat has durable task runtime and safe session delivery adapters', async () => {
  assert.ok(fs.existsSync(new URL('../../engine/voice-task-runtime.mjs', import.meta.url)), 'durable runtime must be available in the main chat worktree')
  const session = await import('../../engine/session-manager.mjs')
  assert.equal(typeof session.canAccessSessionOrigin, 'function')
  assert.equal(typeof session.withIdleSession, 'function')
})

test('main voice task tool handler is available without the lab service', async () => {
  assert.ok(fs.existsSync(new URL('../../engine/chat-voice-tools.mjs', import.meta.url)), 'main chat needs its own confirmation handler')
})
