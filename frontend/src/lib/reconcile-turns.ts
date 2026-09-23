import type { LocalMessage } from './local-db.ts'

/** Align a cached whole-run snapshot with the server's per-model-turn messages.
 * A shared tool-call id establishes ownership; ordered text must also agree.
 * Never deduplicate arbitrary substrings or cross a user-message boundary.
 */
export function reconcileTurnSnapshots(locals: LocalMessage[], history: any[]): any[] {
  const turns: any[][] = [[]]
  const turnByTool = new Map<string, number>()
  for (const message of history) {
    if (message.role === 'user') turns.push([])
    const index = turns.length - 1
    turns[index].push(message)
    if (message.role === 'assistant') {
      for (const tool of message.tools || []) if (tool?.id) turnByTool.set(tool.id, index)
    }
  }

  const candidates = new Map<number, LocalMessage[]>()
  for (const local of locals) {
    if (local.role !== 'assistant') continue
    const indices = new Set<number>()
    for (const tool of local.tools || []) {
      const index = turnByTool.get(tool?.id)
      if (index !== undefined) indices.add(index)
    }
    if (indices.size !== 1) continue
    const index = [...indices][0]
    candidates.set(index, [...(candidates.get(index) || []), local])
  }

  return turns.flatMap((turn, index) => {
    const owners = candidates.get(index)
    if (owners?.length !== 1) return turn
    const local = owners[0]
    const parts = turn.filter(m => m.role === 'assistant')
    if (parts.length < 2) return turn
    const text = parts.map(m => m.text || '').join('')
    const localText = (local.text || '').trim()
    const serverText = text.trim()
    if (localText && serverText && !localText.startsWith(serverText) && !serverText.startsWith(localText)) return turn

    const combined: any = {
      ...parts[parts.length - 1], id: local.id, role: 'assistant', text,
      think: parts.map(m => m.think || '').join(''),
      tools: parts.flatMap(m => m.tools || []),
    }
    for (const field of ['notes', 'files', 'images', 'audios', 'videos']) {
      combined[field] = [...new Map(parts.flatMap(m => m[field] || []).map(value => [JSON.stringify(value), value])).values()]
    }
    for (const field of ['error', 'stopReason', 'truncated', 'model', 'requestedModel', 'switchedModel', 'engine']) {
      const source = [...parts].reverse().find(m => m[field])
      if (source) combined[field] = source[field]
    }
    let inserted = false
    return turn.flatMap(message => {
      if (message.role !== 'assistant') return [message]
      if (inserted) return []
      inserted = true
      return [combined]
    })
  })
}
