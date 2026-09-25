import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from './atomic-io.mjs'
import { appendEpisodes, skillEpisodesFromSessions } from './dream.mjs'

// Each file is acknowledged independently. The legacy global cursor is deliberately
// not imported: it could already have advanced past an unreadable session.
export function createDreamCollector({ wsRoot, sessionsDir,
  extract = files => skillEpisodesFromSessions(files, { strict: true }), append = appendEpisodes }) {
  const stateFile = path.join(wsRoot, '记忆', '运行时', '采集状态.json')
  let pending = null
  const read = () => {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (state.v !== 1 || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)) throw Error('Invalid collection state')
      return state
    } catch (e) { if (e.code === 'ENOENT') return { v: 1, files: {}, last: null }; throw e }
  }
  const fingerprint = file => { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}` }
  async function execute() {
    const state = read()
    const result = { ok: true, at: new Date().toISOString(), scanned: 0, succeeded: 0, failed: 0, skipped: 0, empty: 0, added: 0, failures: [], reason: 'collected' }
    const save = () => { state.last = result; atomicWriteJson(stateFile, state) }
    let names
    try { names = fs.readdirSync(sessionsDir).filter(n => n.endsWith('.jsonl')).sort() }
    catch { result.ok = false; result.failed = 1; result.reason = 'sessions_unreadable'; save(); return result }
    // Remove only acknowledgements of files no longer present, never session data.
    const present = new Set(names)
    for (const key of Object.keys(state.files)) if (!present.has(key)) delete state.files[key]
    let inspected = 0
    for (const name of names) {
      const file = path.join(sessionsDir, name)
      try {
        const before = fingerprint(file)
        if (state.files[name]?.fingerprint === before) { result.skipped++; continue }
        result.scanned++
        const episodes = await extract([file])
        if (fingerprint(file) !== before) throw Error('session_changed')
        const write = await append(wsRoot, episodes)
        if (write?.ok !== true) throw Error('episode_write_failed')
        if (fingerprint(file) !== before) throw Error('session_changed')
        state.files[name] = { fingerprint: before }
        result.succeeded++; result.added += write.added || 0
        if (!episodes.length) result.empty++
      } catch (e) {
        result.failed++
        if (result.failures.length < 20) result.failures.push({ file: name, reason: e.message === 'session_changed' ? '文件仍在写入，下轮重试' : '读取、解析或写入失败，下轮重试' })
      }
      // Flush bounded batches. Crash before acknowledgement can replay observations,
      // whose logical identity is already deduplicated by loadEpisodes.
      if (++inspected % 5 === 0) { save(); await new Promise(r => setImmediate(r)) }
    }
    result.ok = result.failed === 0
    result.reason = result.failed ? 'retry_pending' : result.scanned ? 'collected' : 'no_changes'
    save()
    return result
  }
  return {
    stateFile,
    status() { try { return { ...read().last, running: !!pending } } catch { return { ok: false, reason: 'state_unreadable', running: !!pending } } },
    collect() {
      if (!pending) pending = execute().finally(() => { pending = null })
      return pending
    },
  }
}
