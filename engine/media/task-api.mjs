const allowedKeys = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => keys.includes(key))
export function createVoiceTaskApi({ runtime, authorize, readBody, json }) {
  const handle = async (res, req, action) => {
    if (authorize(req) !== true) return json(res, 401, { error: '未授权', code: 'unauthorized' })
    try { return await action() }
    catch (error) {
      const codes = { invalid_request: 400, request_too_large: 413, conversation_gone: 404, task_not_found: 404, request_conflict: 409, session_busy: 409 }
      const status = codes[error.code] || 503
      return json(res, status, { error: status === 503 ? '任务服务暂不可用，请查询已有回执后再重试' : error.code, code: status === 503 ? 'voice_task_unavailable' : error.code })
    }
  }
  const invalid = () => { throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' }) }
  const parse = async (req, limit) => {
    try { return await readBody(req, limit) }
    catch (error) {
      if (error?.statusCode === 400) invalid()
      if (error?.statusCode === 413) throw Object.assign(new Error('request_too_large'), { code: 'request_too_large' })
      throw error
    }
  }
  return {
    submit: (res, req) => handle(res, req, async () => {
      const body = await parse(req, 0.15)
      if (!allowedKeys(body, ['conversationId', 'requestId', 'tasks'])) invalid()
      return json(res, 202, { group: await runtime.submit(body) })
    }),
    list: (res, req, url) => handle(res, req, async () => {
      const id = url?.searchParams?.get('conversationId')
      if (typeof id !== 'string' || !id.trim() || id.length > 256) invalid()
      return json(res, 200, { tasks: await runtime.list(id) })
    }),
    stop: (res, req, taskId) => handle(res, req, async () => {
      const body = await parse(req, 0.01)
      if (!allowedKeys(body, ['conversationId']) || typeof body.conversationId !== 'string' || !body.conversationId.trim() || body.conversationId.length > 256 || typeof taskId !== 'string' || !taskId || taskId.length > 100) invalid()
      return json(res, 200, { task: await runtime.stop(body.conversationId, taskId) })
    }),
  }
}
