import { json, readBody } from './http-utils.mjs'

export function createVoiceTicketHandler({ admission, origins }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' })
    if (!origins.includes(req.headers.origin)) return json(res, 403, { error: 'origin_rejected' })
    if (!req.headers.authorization?.startsWith('Bearer ')) return json(res, 401, { error: 'unauthorized' })
    try {
      const body = await readBody(req, 0.001)
      if (!body || Object.keys(body).some(k => k !== 'conversationId') || typeof body.conversationId !== 'string') return json(res, 400, { error: 'invalid_request' })
      return json(res, 200, admission.issue(req, body.conversationId))
    } catch (error) {
      const statuses = { unauthorized: 401, conversation_gone: 404, rate_limit: 429, call_busy: 409 }
      const code = Object.hasOwn(statuses, error.message) ? error.message : 'invalid_request'
      return json(res, statuses[code] || 400, { error: code })
    }
  }
}
