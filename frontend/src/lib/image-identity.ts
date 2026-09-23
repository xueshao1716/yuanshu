import { toWorkspaceRel } from './media-embed.ts'

interface ImageMessage {
  role?: string
  images?: string[]
  files?: { path: string }[]
  tools?: any[]
}

function localImageUrl(value: string): string {
  const rel = toWorkspaceRel(value)
  if (!rel || !/\.(png|jpe?g|gif|webp|avif)$/i.test(rel)) return ''
  return '/api/ws/file?path=' + encodeURIComponent(rel)
}

function imageKey(value: string): string {
  // Only workspace URLs ignore signatures. External URLs must retain their full identity.
  const local = localImageUrl(value)
  return local ? local.toLowerCase() : value.trim()
}

/** Recognize explicit literal curl downloads, never infer identity from adjacent URLs,
 * filenames or image dimensions. Unsupported shell syntax leaves both images visible. */
function downloadPairs(command: string): [string, string][] {
  const tokens = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|&&|\|\||[;|\r\n]|[^\s;&|]+/g) || []
  const segments: string[][] = [[]]
  for (const token of tokens) {
    if (/^(?:&&|\|\||[;|\r\n])$/.test(token)) segments.push([])
    else segments[segments.length - 1].push(token.replace(/^(["'])(.*)\1$/, '$2'))
  }
  const pairs: [string, string][] = []
  for (const [exe, ...args] of segments) {
    if (!/^curl(?:\.exe)?$/i.test(exe || '')) continue
    let source = '', target = '', valid = true
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '-o' || arg === '--output') { if (target) valid = false; target = args[++i] || '' }
      else if (arg === '--url') { if (source) valid = false; source = args[++i] || '' }
      else if (/^https?:\/\//.test(arg)) { if (source) valid = false; source = arg }
      else if (!/^(?:-[sSLf]+|--silent|--show-error|--location|--fail)$/.test(arg)) valid = false
    }
    if (valid && /^https?:\/\//.test(source) && localImageUrl(target) && !/[$`\r\n]/.test(source + target)) {
      pairs.push([source, localImageUrl(target)])
    }
  }
  return pairs
}

function aliasesFor(messages: ImageMessage[]): Map<string, string> {
  const available = new Map<string, string>()
  for (const message of messages) {
    for (const url of message.images || []) if (localImageUrl(url)) available.set(imageKey(url), url)
    for (const file of message.files || []) {
      const url = localImageUrl(file.path)
      if (url && !available.has(imageKey(url))) available.set(imageKey(url), url)
    }
  }
  const aliases = new Map<string, string>()
  if (!available.size) return aliases
  for (const tool of messages.flatMap(m => m.tools || [])) {
    if (tool.name !== 'bash' || tool.isError || tool.running || ['running', 'error', 'canceled'].includes(tool.status)) continue
    // A completed result plus an emitted image/file is required; a command alone is not proof.
    if (typeof tool.output !== 'string' || !tool.output.trim()) continue
    let args = tool.args ?? tool.argsText
    // History stores args objects; the stream assembler stores the literal command as argsText.
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = { command: args } } }
    if (typeof args?.command !== 'string') continue
    for (const [source, target] of downloadPairs(args.command)) {
      const delivered = available.get(imageKey(target))
      if (delivered) aliases.set(imageKey(source), delivered)
    }
  }
  return aliases
}

/** Normalize one live snapshot or one user turn without altering the source records. */
export function reconcileImageMessages<T extends ImageMessage>(messages: T[]): T[] {
  const turns: T[][] = []
  for (const message of messages) {
    if (!turns.length || message.role === 'user') turns.push([])
    turns[turns.length - 1].push(message)
  }
  return turns.flatMap(turn => {
    const assistants = turn.filter(m => m.role !== 'user' && m.role !== 'system')
    const aliases = aliasesFor(assistants)
    const seen = new Set<string>()
    return turn.map(message => {
      if (!message.images?.length) return message
      const ownSeen = message.role === 'user' || message.role === 'system' ? new Set<string>() : seen
      const images: string[] = []
      for (const original of message.images) {
        if (!original) continue
        const url = message.role === 'user' ? original : aliases.get(imageKey(original)) || original
        const key = imageKey(url)
        if (!ownSeen.has(key)) { ownSeen.add(key); images.push(url) }
      }
      return { ...message, images }
    })
  })
}
