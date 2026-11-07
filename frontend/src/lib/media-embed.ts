const VIDEO = /\.(mp4|webm|mov)(?:\b|$)/i

/**
 * 聊天里能不能给这条地址放播放器（2026-11-07）。
 * 只认本地/同源产物：/api/ws/file?...、生成物/工程/交付 开头的相对路径。
 * 远端 http(s) 一律不进播放器——签名链接几小时就过期，示例链接更是死链，
 * 播不了只会留一个永远转圈的黑框。远端地址交给正文文本 + 链接。
 * 注意：影视页直播源走 lib/tv.ts 直连原始 m3u8，不套这个判据。
 */
export function isChatPlayableUrl(url: string): boolean {
  const s = String(url || '').trim().replace(/^["'`<]+|[>"'`]+$/g, '')
  if (!s) return false
  if (/^data:video\//i.test(s)) return true
  if (/^\.?\/api\/ws\/file(?:[?#]|$)/i.test(s)) return true
  if (/^(?:生成物|工程|workshop-out|交付)[\\/]/i.test(s)) return true
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/api\/ws\/file(?:[?#]|$)/i.test(s)
}

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
  const push = (url: string) => {
    if (!url || url.includes('/api/ws/file')) return
    const k = mediaPathKey(url)
    if (out.some(x => mediaPathKey(x) === k)) return
    out.push(url)
  }
  // 同源代理路径（B 站音轨等）：/api/music/stream?u=...，前端会补 token
  for (const m of raw.matchAll(/\/api\/music\/stream\?u=[A-Za-z0-9_-]+/g)) push(m[0])
  for (const m of raw.matchAll(/https?:\/\/[^\s)）"'<>\]]+?\.(?:mp3|m4a|aac|wav|ogg|opus)(?:\?[^\s)）"'<>\]]*)?/gi)) {
    push(m[0].replace(/[.,;。，]+$/, ''))
  }
  return out
}

export function scrapeVideos(text: string): string[] {
  const out: string[] = []
  const add = (u: string) => {
    if (!u) return
    // 只认本地/同源片子：远端签名链接、example.com 之类的示例链接不再变成播放器。
    if (!isChatPlayableUrl(u)) return
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
  // 2026-11-07：外链视频不再抓。以前这里把 https://…\.mp4|webm|m3u8 也塞进播放器，
  // 上游签名链接一过期、示例链接本来就不存在，聊天里就多出一个播不了的窗口。
  for (const rawHit of hits) {
    const hit = clipMediaPath(rawHit)
    const url = hit.startsWith('/api/ws/file') ? hit.split('&')[0] : workspaceFileUrl(hit)
    if (!url) continue
    const pathPart = url.includes('path=') ? decodeURIComponent(url.split('path=')[1] || '') : hit
    if (VIDEO.test(pathPart) || VIDEO.test(hit)) add(url)
  }
  return out
}
