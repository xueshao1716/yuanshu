/** Auth is enforced by the server route registry before these handlers run. */
export function createCompanionRoutes({ exists, facts, store, decisions, json, readBody }) {
  const valid = id => typeof id === 'string' && /^[\w-]{1,160}$/.test(id) && exists(id);
  const missing = res => json(res, 404, { error: '会话不存在' });
  return [
    ['GET', '/api/companion/facts', (res, _req, url) => {
      const id = url.searchParams.get('sessionId');
      return valid(id) ? json(res, 200, facts.read(id)) : missing(res);
    }],
    ['GET', '/api/companion/history', (res, _req, url) => {
      const id = url.searchParams.get('sessionId');
      return valid(id) ? json(res, 200, { items: store.history(id) }) : missing(res);
    }],
    ['GET', '/api/companion/preferences', res => json(res, 200, store.preferences())],
    ['POST', '/api/companion/preferences', async (res, req) => {
      const body = await readBody(req, 0.016);
      if (!body || typeof body.dnd !== 'boolean' || Object.keys(body).some(k => k !== 'dnd')) return json(res, 400, { error: 'invalid_preferences' });
      return json(res, 200, store.preferences(body));
    }],
    ['POST', '/api/companion/decision', async (res, req) => {
      const body = await readBody(req, 0.016);
      if (!valid(body?.sessionId)) return missing(res);
      const controller = new AbortController(), abort = () => controller.abort();
      res.on('close', abort); req.on('aborted', abort);
      if (res.destroyed || req.aborted) abort();
      try {
        const result = await decisions.decide(body, controller.signal);
        if (!res.destroyed) return json(res, 200, result);
      } finally { res.removeListener('close', abort); req.removeListener('aborted', abort); }
    }],
  ];
}
