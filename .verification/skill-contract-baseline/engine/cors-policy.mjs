const LOCAL_SHELL_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'capacitor://localhost',
  'http://localhost',
]

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/+$/, '')
}

export function createCorsPolicy(configured = '') {
  const configuredOrigins = String(configured || '').split(',').map(normalizeOrigin).filter(Boolean)
  const origins = new Set([...LOCAL_SHELL_ORIGINS, ...configuredOrigins])
  return {
    allowedOrigin(origin) {
      const normalized = normalizeOrigin(origin)
      return normalized && origins.has(normalized) ? normalized : null
    },
    headers(origin) {
      const allowed = this.allowedOrigin(origin)
      const headers = { Vary: 'Origin' }
      if (allowed) {
        Object.assign(headers, {
          'Access-Control-Allow-Origin': allowed,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID',
          'Access-Control-Allow-Credentials': 'true',
        })
      }
      return headers
    },
  }
}

export { LOCAL_SHELL_ORIGINS }
