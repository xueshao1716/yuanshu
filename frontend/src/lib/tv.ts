import { apiUrl, getToken } from '../api'

export const isExternalVideo = (url: string) => /^https?:\/\//i.test(url) && !url.includes('/api/ws/file')
export const isHlsUrl = (url: string) => /\.m3u8(?:[?#]|$)/i.test(url)

/** 外链视频走同源代理（防盗链 / CORS / 混合内容）；video 与 hls.js 带不了 Authorization 头，用 query token。 */
export function tvMediaUrl(url: string): string {
  const params = new URLSearchParams({ url })
  const token = getToken()
  if (token) params.set('token', token)
  return apiUrl(`/api/tv/media?${params.toString()}`)
}
