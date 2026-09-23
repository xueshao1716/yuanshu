import type { LocalMessage } from './local-db.ts'
import { mediaPathKey, toWorkspaceRel } from './media-embed.ts'

function toolArgs(tool: any): any {
  let args = tool?.args ?? tool?.argsText
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = { command: args } } }
  return args || {}
}

function readOnlyTool(tool: any): boolean {
  if (tool?.name === 'read') return true
  const command = toolArgs(tool).command
  return tool?.name === 'bash' && typeof command === 'string'
    && !/[$`<>()\r\n]|--pre\b/.test(command)
    && command.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, 'ARG').split(/&&|&|;|\|/)
      .every((s: string) => /^(?:cd|cat|head|tail|rg|grep|wc)(?:\s|$)/.test(s.trim()))
}

function mentions(text: string, relative: string): boolean {
  let normalized = String(text || '')
  try { normalized = decodeURIComponent(normalized) } catch { /* literal text */ }
  return normalized.replace(/\\/g, '/').toLowerCase().includes(relative.toLowerCase())
}

/** Use completed tools from this cached turn, or matching server tool-call ids.
 * Never touch a draft, upload, unknown provenance, delivery or generation result.
 * This repairs only derived attachment lists, not text, tools or original files.
 */
export function cleanLegacyReferenceCache(local: LocalMessage, server?: any): LocalMessage {
  if (local.role !== 'assistant' || local.draft || local.streaming) return local
  const localIds = new Set((local.tools || []).map(t => t.id).filter(Boolean))
  const readers = (server?.tools || (!server ? local.tools : []) || [])
    .filter((t: any) => localIds.has(t.id) && !t.running && !t.isError && readOnlyTool(t))
  if (!readers.length) return local
  const known = new Set<string>(['images', 'videos', 'audios'].flatMap(k => server?.[k] || []).map(mediaPathKey))
  for (const f of [...(local.files || []), ...(server?.files || [])]) if (f?.path) known.add(mediaPathKey(f.path))
  const deliveries = (local.tools || []).filter(t => !t.isError && (
    /^(generate_image|generate_video|generate_tts|image_gen|video_gen|tts)$/.test(t.name || '')
    || (t.name === 'bash' && /(?:^|[;&|]\s*|\s)(curl|wget)\s/.test(toolArgs(t).command || ''))))
  const safe = (url: string) => {
    const rel = toWorkspaceRel(url)
    if (!rel || known.has(mediaPathKey(url))) return true
    if (mentions(local.text, rel) || mentions(server?.text, rel)) return true
    if (deliveries.some(t => mentions(t.output, rel) || mentions(toolArgs(t).command, rel))) return true
    return !readers.some((t: any) => mentions(t.output, rel))
  }
  return { ...local, images: local.images?.filter(safe), videos: local.videos?.filter(safe), audios: local.audios?.filter(safe) }
}
