export function appendTranscript(list, event) {
  if (!['user', 'assistant'].includes(event.role) || typeof event.text !== 'string' || !event.text) return list
  const next = list.map(item => ({ ...item }))
  const last = next.at(-1)
  if (event.role === 'assistant' && event.responseId && last?.responseId === event.responseId) last.text += event.text
  else next.push({ role: event.role, text: event.text, responseId: event.responseId })
  let remaining = 16000
  return next.slice(-40).reverse().flatMap(item => {
    if (!remaining) return []
    const text = item.text.slice(-remaining); remaining -= text.length
    return [{ ...item, text }]
  }).reverse()
}
