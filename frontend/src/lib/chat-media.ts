import { mediaPathKey, scrapeVideos } from './media-embed.ts'

export type ChatMedia = { src: string; kind: 'image' | 'video'; name: string }
type MediaMessage = { sessionId?: string; text?: string; images?: string[]; videos?: string[] }

export function mediaFilename(src: string, kind: ChatMedia['kind']): string {
  try {
    const url = new URL(src, 'http://workspace.invalid')
    let path = url.searchParams.get('path') || url.pathname
    if (!url.searchParams.has('path')) { try { path = decodeURIComponent(path) } catch { /* Keep malformed escapes readable. */ } }
    const name = path.replace(/\\/g, '/').split('/').pop()?.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || ''
    if (/\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)$/i.test(name)) return name
  } catch { /* Incomplete addresses get an explicit media extension. */ }
  return kind === 'video' ? '元枢视频.mp4' : '元枢图片.png'
}

export function collectChatMedia(messages: MediaMessage[], sessionId: string): ChatMedia[] {
  if (!sessionId) return []
  const result: ChatMedia[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.sessionId && message.sessionId !== sessionId) continue
    const videos = message.videos?.length ? message.videos : scrapeVideos(message.text || '')
    for (const [kind, urls] of [['image', message.images || []], ['video', videos]] as const) {
      for (const src of urls) {
        const key = `${kind}:${mediaPathKey(src)}`
        if (!src || seen.has(key)) continue
        seen.add(key)
        result.push({ src, kind, name: mediaFilename(src, kind) })
      }
    }
  }
  return result
}

export function mediaSwipe(dx: number, dy: number): 'next' | 'previous' | 'close' | null {
  if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5) return dx < 0 ? 'next' : 'previous'
  if (dy > 90 && dy > Math.abs(dx) * 1.5) return 'close'
  return null
}
