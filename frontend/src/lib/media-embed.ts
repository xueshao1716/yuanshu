const VIDEO = /\.(mp4|webm|mov)(?:\b|$)/i

function clipMediaPath(s: string): string {
  const m = String(s || '').match(/^(.*?\.(?:mp4|webm|mov|png|jpe?g|gif|webp|mp3|wav|m4a))/i)
  return m ? m[1] : String(s || '')
}

export function workspaceFileUrl(p: string): string {
  const rel = toWorkspaceRel(clipMediaPath(p))
  if (!rel) return ''
  return '/api/ws/file?path=' + encodeURIComponent(rel)
}

export function toWorkspaceRel(p: string): string {
  let s = String(p || '').trim().replace(/^["'`<]+|[>"'`]+$/g, '')
  if (!s) return ''
  if (s.startsWith('/api/ws/file')) {
    const m = s.match(/[?&]path=([^&\s]+)/)
    if (!m) return ''
    try { return decodeURIComponent(m[1]).replace(/\\/g, '/') } catch { return m[1] }
  }
  const unified = s.replace(/\//g, '\\')
  const ws = unified.match(/^[A-Za-z]:\\(?:[^\\]+\\)*(?:yuanshu-space|pi-workspace)\\(.+)$/i)
  if (ws) return ws[1].replace(/\\/g, '/')
  if (/^(生成物|工程|workshop-out|交付)[\\/]/i.test(s)) return s.replace(/\\/g, '/')
  return ''
}

/** 同一片子：忽略 exp/sig/token，只按 path 判重。 */
export function mediaPathKey(url: string): string {
  const rel = toWorkspaceRel(url)
  if (rel) return rel.replace(/\\/g, '/').toLowerCase()
  const m = String(url || '').match(/[?&]path=([^&\s]+)/)
  if (m) {
    try { return decodeURIComponent(m[1]).replace(/\\/g, '/').toLowerCase() } catch { return m[1].toLowerCase() }
  }
  return String(url || '').trim()
}

export function dedupeMediaUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of urls || []) {
    if (!u) continue
    const k = mediaPathKey(u)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(u)
  }
  return out
}

/** 外链音频（音乐试听直链）：iTunes / Deezer 的试听都是 .m4a / .mp3，直接进 <audio>。 */
export function scrapeAudios(text: string): string[] {
  const out: string[] = []
  const raw = String(text || '')
  for (const m of raw.matchAll(/https?:\/\/[^\s)）"'<>\]]+?\.(?:mp3|m4a|aac|wav|ogg|opus)(?:\?[^\s)）"'<>\]]*)?/gi)) {
    const url = m[0].replace(/[.,;。，]+$/, '')
    if (!url || url.includes('/api/ws/file')) continue
    const k = mediaPathKey(url)
    if (out.some(x => mediaPathKey(x) === k)) continue
    out.push(url)
  }
  return out
}

export function scrapeVideos(text: string): string[] {
  const out: string[] = []
  const add = (u: string) => {
    if (!u) return
    const k = mediaPathKey(u)
    if (!k || out.some(x => mediaPathKey(x) === k)) return
    out.push(u)
  }
  const raw = String(text || '')
  const hits = new Set<string>()
  for (const m of raw.matchAll(/\/api\/ws\/file\?path=[^\s)）"'<>]+/g)) hits.add(m[0].replace(/[.,;。，]+$/, ''))
  for (const m of raw.matchAll(/[A-Za-z]:\\[^\s)）"'<>]+/g)) hits.add(m[0].replace(/[.,;。，]+$/, ''))
  for (const m of raw.matchAll(/(?:生成物|工程|workshop-out|交付)[\\/][^\s)）"'<>]+/g)) hits.add(m[0].replace(/[.,;。，]+$/, ''))
  for (const m of raw.matchAll(/📎\s*交付:\s*(\S+)/g)) hits.add(m[1])
  // 外链视频：只认明确的 m3u8 / mp4 / webm 链接，由播放器经同源代理播放
  for (const m of raw.matchAll(/https?:\/\/[^\s)）"'<>\]]+?\.(?:m3u8|mp4|webm)(?:\?[^\s)）"'<>\]]*)?/gi)) {
    if (!m[0].includes('/api/ws/file')) add(m[0].replace(/[.,;。，]+$/, ''))
  }
  for (const rawHit of hits) {
    const hit = clipMediaPath(rawHit)
    const url = hit.startsWith('/api/ws/file') ? hit.split('&')[0] : workspaceFileUrl(hit)
    if (!url) continue
    const pathPart = url.includes('path=') ? decodeURIComponent(url.split('path=')[1] || '') : hit
    if (VIDEO.test(pathPart) || VIDEO.test(hit)) add(url)
  }
  return out
}
