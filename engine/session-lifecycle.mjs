import fs from 'node:fs'
import { createHash } from 'node:crypto'

// Tokens live only as long as their operation: cancellation cannot leak tombstones.
export function createSessionLifecycle() {
  const pending = new Set()
  return {
    begin(kind, id, file) {
      const token = { kind, id, file, cancelled: false }
      pending.add(token)
      return token
    },
    end(token) { pending.delete(token) },
    cancel(id, file) {
      for (const token of pending) {
        if (token.id === id || (file && token.file === file)) token.cancelled = true
      }
    },
    find(kind, id) { return [...pending].find(t => !t.cancelled && t.kind === kind && t.id === id) },
    fileFor(id) { return [...pending].find(t => t.id === id)?.file },
    locked(id, file) { return [...pending].some(t => !t.cancelled && (t.id === id || t.file === file)) },
    current(token, allowMissing = false) { return !token.cancelled && (allowMissing || fs.existsSync(token.file)) },
  }
}

// Compare content as well as identity/times; same-size edits and replacement files
// must not be overwritten by a summary generated from an earlier snapshot.
export function sessionFileVersion(file) {
  try {
    const st = fs.statSync(file, { bigint: true })
    return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs,
      createHash('sha256').update(fs.readFileSync(file)).digest('hex')].join(':')
  } catch { return null }
}

export function conversationGone() {
  return Object.assign(new Error('conversation_gone'), { code: 'conversation_gone' })
}

export function disposeAgent(agent) { try { agent?.dispose?.() } catch {} }
