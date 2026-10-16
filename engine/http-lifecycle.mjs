import { json } from './http-utils.mjs';

/** Observe the transport, not the lifetime of the route handler's promise. */
export function observeHttpRequest(req, res, requestId, log = console.log, { slowMs = 0, onSlow = null } = {}) {
  const started = performance.now();
  // Capture before static handlers rewrite req.url. Never log queries or headers.
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}
  let failed = false;
  let recorded = false;
  const record = outcome => {
    if (recorded) return;
    recorded = true;
    res.off('finish', onFinish);
    res.off('close', onClose);
    if (pathname.startsWith('/static/')) return;
    try {
      const durationMs = Math.round(performance.now() - started);
      const entry = { event: 'http_request', requestId, method: req.method,
        path: pathname, status: res.statusCode, outcome: failed ? 'failed' : outcome, durationMs };
      log(JSON.stringify(entry));
      // 慢请求单独留证据；长连接（事件流）本来就久，不算。
      if (onSlow && slowMs > 0 && durationMs >= slowMs && !/event-stream/i.test(String(res.getHeader('content-type') || ''))) {
        onSlow({ at: new Date().toISOString(), ...entry });
      }
    } catch { /* Logging must never break a response. */ }
  };
  const onFinish = () => record('finished');
  const onClose = () => record(res.writableFinished ? 'finished' : 'aborted');
  res.once('finish', onFinish);
  res.once('close', onClose);
  return { fail() { failed = true; } };
}

/** Keep existing string error responses; do not expose unexpected exception text. */
export function respondHttpError(res, error, requestId) {
  if (res.destroyed || res.writableEnded) return;
  // Once streaming has begun we cannot replace headers or invent a protocol event.
  // An aborted transport is visible to the existing reconnect/recovery handlers.
  if (res.headersSent) { res.destroy(); return; }
  const candidate = Number(error?.statusCode);
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  const message = status < 500 ? String(error?.message || '请求无效') : '内部服务错误，请凭请求编号查看服务日志';
  try { json(res, status, { error: message, requestId }); }
  catch { res.destroy(); }
}
