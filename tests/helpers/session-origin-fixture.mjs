import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as manager from '../../engine/session-manager.mjs'
import { createPiCompatFallback } from '../../engine/pi-compat-fallback.mjs'
import { initSessionFiles, invalidateSessionCache } from '../../engine/session-files.mjs'

export function originFixture(t, { lazy = false, onOpen = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-origin-auth-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cwd = path.join(root, 'workspace'), sessionsDir = path.join(root, 'sessions', 'workspace')
  fs.mkdirSync(cwd, { recursive: true })
  const { SessionManager: Fallback } = createPiCompatFallback({ agentDir: path.join(root, 'agent') })
  const origin = Fallback.create(cwd, sessionsDir), id = origin.getSessionId(), file = origin.getSessionFile()
  const header = { type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() }
  fs.writeFileSync(file, JSON.stringify(header) + '\n')
  const active = new Map()
  const effects = { opens: 0, agents: 0, disposed: 0 }
  const configure = (overrides = {}) => {
    initSessionFiles({ sessionsDir, workspaceCwd: cwd }); invalidateSessionCache()
    manager.initSessionManager({ cwd, sessionsDir, activeSessions: active,
      SessionManager: {
        open(...args) { effects.opens++; const sm = Fallback.open(...args); onOpen?.({ sm, active, file, id }); return sm },
        create(newCwd, dir) {
          const sm = Fallback.create(newCwd, dir)
          if (lazy) {
            sm.fileEntries = sm.getFileEntries(); sm.getHeader = () => sm.fileEntries[0]
            fs.unlinkSync(sm.getSessionFile()); sm.flushed = false
            sm.appendSessionInfo = name => sm.fileEntries.push({ type: 'session_info', name })
          }
          return sm
        },
      },
      getDefaultModel: () => null, getModelList: () => [], getAgentDir: () => root,
      readJsonFile: () => ({}), writeJsonFile: () => {}, onSessionCreated: () => {},
      agentFactory: async () => { effects.agents++; return { dispose() { effects.disposed++ } } },
      ...overrides,
    })
  }
  configure()
  return { root, cwd, sessionsDir, origin, id, file, header, active, effects, configure,
    write(rows, target = file) { fs.writeFileSync(target, rows.map(JSON.stringify).join('\n') + '\n'); invalidateSessionCache() },
  }
}

export function makeLink(t, source, target, type) {
  try { fs.symlinkSync(source, target, type); return true }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`OS denied ${type} creation: ${error.code}`); return false }
    throw error
  }
}
