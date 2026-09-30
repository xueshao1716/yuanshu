import { json, readBody } from './http-utils.mjs'

export function createVoiceTicketHandler({ admission, origins }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' })
    if (!origins.includes(req.headers.origin)) return json(res, 403, { error: 'origin_rejected' })
    if (!req.headers.authorization?.startsWith('Bearer ')) return json(res, 401, { error: 'unauthorized' })
    try {
      const body = await readBody(req, 0.001)
      if (!body || Object.keys(body).some(k => !['conversationId', 'modelKey'].includes(k)) || typeof body.conversationId !== 'string'
        || (body.modelKey !== undefined && (typeof body.modelKey !== 'string' || !body.modelKey || body.modelKey.length > 200))) return json(res, 400, { error: 'invalid_request' })
      return json(res, 200, admission.issue(req, body.conversationId, body.modelKey))
    } catch (error) {
      const statuses = { unauthorized: 401, conversation_gone: 404, rate_limit: 429, call_busy: 409, voice_model_unsupported: 400, voice_model_unavailable: 503 }
      const code = Object.hasOwn(statuses, error.message) ? error.message : 'invalid_request'
      return json(res, statuses[code] || 400, { error: code })
    }
  }
}

export function createVoiceModelsHandler({ registry, authorize }) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' })
    if (!authorize(req)) return json(res, 401, { error: 'unauthorized' })
    try { return json(res, 200, { models: registry.list() }) }
    catch { return json(res, 503, { error: 'voice_model_unavailable' }) }
  }
}
