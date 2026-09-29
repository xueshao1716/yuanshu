import { timingSafeEqual } from 'node:crypto'

export function createVoiceTaskAuthorizer({ getToken, origins }) {
  return req => {
    const token = getToken(), actual = req.headers?.authorization
    if (!token || typeof actual !== 'string') return false
    const expected = `Bearer ${token}`
    if (Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return false
    const origin = req.headers.origin
    return req.method === 'GET' && !origin || origins.includes(origin)
  }
}
