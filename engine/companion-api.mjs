/** Auth is enforced by the server route registry before these handlers run. */
export function createCompanionRoutes({ exists, facts, store, decisions, json, readBody, nudge = null }) {
  const valid = id => typeof id === 'string' && /^[\w-]{1,160}$/.test(id) && exists(id);
  const missing = res => json(res, 404, { error: '会话不存在' });
  return [
    ['GET', '/api/companion/facts', async (res, _req, url) => {
      const id = url.searchParams.get('sessionId');
      if (!valid(id)) return missing(res);
      // 有人在前台轮询 = 用户在。久不互动推送靠这个时间判断（每分钟最多写一次盘）
      try { store.touchSeen?.(); } catch { /* 记账失败不影响读数 */ }
      return json(res, 200, await facts.read(id));
    }],
    // 手动触发一次"久不互动"推送（force=1 时无视冷却，便于验证通道）
    ['POST', '/api/companion/nudge', async (res, req) => {
      const body = await readBody(req, 0.016).catch(() => ({}));
      try {
        const result = await nudge?.run?.({ force: body?.force === true });
        return json(res, 200, result || { ok: false, reason: 'unavailable' });
      } catch (e) { return json(res, 500, { ok: false, error: String(e?.message || e).slice(0, 160) }); }
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
