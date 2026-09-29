export function selectVoiceContext(messages) {
  const recent = messages.filter(m => ['user', 'assistant'].includes(m.role))
    .map(m => ({ role: m.role, content: typeof m.text === 'string' ? m.text : typeof m.content === 'string' ? m.content : '' }))
    .filter(m => m.content.trim()).slice(-12)
  let remaining = 8000
  return recent.reverse().flatMap(m => {
    const content = m.content.slice(-remaining)
    if (!remaining) return []
    remaining -= content.length
    return [{ role: m.role, content }]
  }).reverse()
}

export function createVoiceSessionReader({ activeSessions, findSession, readEntriesFromFile, extractMessages, resolveLeafId }) {
  return id => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null
    const active = activeSessions.get(id), found = active ? null : findSession(id)
    if (!active && !found) return null
    try {
      const entries = active?.sm?.fileEntries || readEntriesFromFile(found.file)
      return selectVoiceContext(extractMessages(entries, active?.sm?.getLeafId?.() || resolveLeafId(entries)))
    } catch { return null }
  }
}
