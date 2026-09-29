import path from 'node:path'
import { validateSessionOrigin } from './session-origin-auth.mjs'

// No await between checking lifecycle locks and persisting through the live SDK.
export function createIdleSessionWriter({ activeSessions, SessionManager, findSession, isLocked = () => false, canUseUnpersisted = () => false, cwd, sessionsDir, invalidate = () => {} }) {
  return (id, append) => {
    const live = activeSessions.get(id)
    const found = findSession(id)
    const file = live?.sm?.getSessionFile?.() || found?.file
    const authorized = sm => validateSessionOrigin({ id, file, cwd, sessionsDir, sm,
      allowUnpersisted: !!live && canUseUnpersisted(id, live) })
    if ((live && !live.sm) || !authorized(live?.sm)) return { code: 'conversation_gone' }
    if (live?.busy || live?.agent?.isCompacting || isLocked(id, file)) throw Object.assign(new Error('session_busy'), { code: 'session_busy' })
    const sm = live?.sm || SessionManager.open(file, path.dirname(file), found?.cwd || cwd)
    if (activeSessions.get(id) !== live || !authorized(sm)) return { code: 'conversation_gone' }
    if (live?.busy || live?.agent?.isCompacting || isLocked(id, file)) throw Object.assign(new Error('session_busy'), { code: 'session_busy' })
    try {
      const result = append(sm)
      if (result?.then) throw new Error('session_append_must_be_synchronous')
      return result
    } finally {
      // Agent context is a snapshot; reopen after append rather than reply from stale history.
      if (live && activeSessions.get(id) === live) { try { live.agent?.dispose?.() } catch {} activeSessions.delete(id) }
      invalidate()
    }
  }
}
