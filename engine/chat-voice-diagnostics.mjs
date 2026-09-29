import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from './atomic-io.mjs'

// A small local ring, written only at connection boundaries, never per audio frame.
// Do not include provider messages, transcripts, session IDs, audio or credentials.
export function createVoiceDiagnostics({ rootDir }) {
  const file = path.join(rootDir, 'voice-calls', 'diagnostics.json')
  let rows
  return entry => {
    try {
      if (!rows) {
        try { rows = fs.statSync(file).size <= 128 * 1024 ? JSON.parse(fs.readFileSync(file, 'utf8')) : [] } catch { rows = [] }
        if (!Array.isArray(rows)) rows = []
      }
      const label = value => typeof value === 'string' && /^[a-z_]{1,48}$/.test(value) ? value : undefined
      const row = { at: new Date().toISOString(), pid: process.pid, event: label(entry.event),
        stage: label(entry.stage), code: label(entry.code),
        elapsedMs: Number.isFinite(entry.elapsedMs) ? Math.max(0, Math.round(entry.elapsedMs)) : 0 }
      rows = [...rows.slice(-199), row]
      atomicWriteJson(file, rows)
    } catch { /* Diagnostics must never stop or delay recovery of a call. */ }
  }
}
