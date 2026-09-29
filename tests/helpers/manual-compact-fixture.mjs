import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as manager from '../../engine/session-manager.mjs'
import { createPiCompatFallback } from '../../engine/pi-compat-fallback.mjs'
import { initSessionFiles, invalidateSessionCache } from '../../engine/session-files.mjs'
import { initStatsApi, handleCompact } from '../../engine/stats-api.mjs'

export function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

export function manualCompactFixture(t, { cached = true, lazy = false, waitAgent = false, waitBeforeController = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-manual-compact-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessionsDir = path.join(root, 'sessions', 'workspace')
  const { SessionManager: Fallback } = createPiCompatFallback({ agentDir: root })
  const origin = Fallback.create(root, sessionsDir), id = origin.getSessionId(), file = origin.getSessionFile()
  origin.appendMessage({ role: 'user', content: 'fixture history' })
  const active = new Map(), started = deferred(), release = deferred(), agentStarted = deferred(), agentRelease = deferred()
  const beforeController = deferred(), controllerRelease = deferred()
  let failure = null
  const agent = {
    disposed: 0, compactCalls: 0, isCompacting: false,
    dispose() { this.disposed++; release.resolve() },
    async compact() {
      this.compactCalls++; beforeController.resolve()
      // The SDK awaits abort() before creating its manual-compaction controller.
      if (waitBeforeController) await controllerRelease.promise
      this.isCompacting = true; started.resolve()
      try { await release.promise; if (failure) throw failure; return { summary: 'fixture summary' } }
      finally { this.isCompacting = false }
    },
  }
  const entry = { sm: origin, agent, busy: false, lastUsed: Date.now() }
  if (cached) active.set(id, entry)
  initSessionFiles({ sessionsDir, workspaceCwd: root }); invalidateSessionCache()
  manager.initSessionManager({ cwd: root, sessionsDir, activeSessions: active,
    SessionManager: { open: (...args) => Fallback.open(...args), create(cwd, dir) {
      const sm = Fallback.create(cwd, dir)
      if (lazy) {
        sm.fileEntries = sm.getFileEntries(); sm.getHeader = () => sm.fileEntries[0]
        fs.unlinkSync(sm.getSessionFile()); sm.flushed = false; sm.appendSessionInfo = () => {}
      }
      return sm
    } },
    getDefaultModel: () => ({ provider: 'fixture', id: 'fixture' }), getModelList: () => [],
    getAgentDir: () => root, readJsonFile: () => ({}), writeJsonFile: () => {}, onSessionCreated: () => {},
    agentFactory: async () => { agentStarted.resolve(); if (waitAgent) await agentRelease.promise; return agent },
    summaryFetch: async () => { throw new Error('unexpected summary fetch') },
  })
  initStatsApi({ openSession: manager.openSession,
    compactSessionAgent: manager.compactSessionAgent, getDefaultModel: () => ({ provider: 'fixture', id: 'fixture' }) })
  return { id, file, origin, entry, active, agent, started, release, agentStarted, agentRelease, beforeController, controllerRelease,
    fail: error => { failure = error },
    request(sid = id) {
      const res = { status: null, body: null, writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
      return { res, pending: handleCompact(res, sid) }
    },
  }
}
