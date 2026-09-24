/** Workspace links belong to the connected server, even when history contains an old host/signature. */
export function fileAccess(path: string, base: string, token: string, download = false): { url: string; headers: Record<string, string> } {
  if (!path) return { url: '', headers: {} }
  const root = base.replace(/\/+$/, '')
  const parsed = new URL(path, 'http://workspace.invalid')
  const workspace = parsed.pathname === '/api/ws/file' && parsed.searchParams.has('path')
  const relativeApi = path.startsWith('/api/')
  if (workspace) {
    if (token) {
      for (const key of ['sig', 'exp', 'token']) parsed.searchParams.delete(key)
      // Fetch downloads can authenticate in headers; media elements cannot.
      if (!download) parsed.searchParams.set('token', token)
    }
    if (download) parsed.searchParams.set('download', '1')
    return { url: `${root}${parsed.pathname}?${parsed.searchParams}`, headers: token ? { Authorization: `Bearer ${token}` } : {} }
  }
  if (relativeApi) return { url: `${root}${path}`, headers: token ? { Authorization: `Bearer ${token}` } : {} }
  if (!['http:', 'https:', 'blob:'].includes(parsed.protocol)) throw new Error('不支持此文件地址，请从资产库重新打开')
  return { url: path, headers: {} }
}
