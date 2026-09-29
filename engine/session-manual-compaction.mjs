import { conversationGone } from './session-lifecycle.mjs'

const sessionBusy = () => Object.assign(new Error('session_busy'), { code: 'session_busy' })

// Reserve before openSession's first await, including already-cached entries.
// Opening/rebuilding keep their own tokens; this reservation does not block them.
export async function compactManagedSession(id, model, {
  lifecycle, activeSessions, findSession, openSession, ensureAgent, hasSessionFile,
}) {
  if (lifecycle.find('manual-compacting', id)) throw sessionBusy()
  const file = activeSessions.get(id)?.sm?.getSessionFile?.() || findSession(id)?.file
  const token = lifecycle.begin('manual-compacting', id, file)
  let entry
  const current = () => !token.cancelled && entry && activeSessions.get(id) === entry
    && entry.sm.getSessionId() === id && hasSessionFile(entry.sm, token.file)
  try {
    entry = await openSession(id)
    if (!entry || token.cancelled) throw conversationGone()
    token.file = entry.sm.getSessionFile()
    if (!current()) throw conversationGone()
    if (entry.busy || entry.agent?.isCompacting) throw sessionBusy()
    const agent = await ensureAgent(entry, model)
    if (!current() || entry.agent !== agent) throw conversationGone()
    if (entry.busy || agent.isCompacting) throw sessionBusy()
    const result = await agent.compact()
    if (!current() || entry.agent !== agent) throw conversationGone()
    return result
  } catch (error) {
    // SDK disposal may reject its pending compaction; deletion still means gone.
    if (token.cancelled) throw conversationGone()
    throw error
  } finally {
    lifecycle.end(token)
  }
}
