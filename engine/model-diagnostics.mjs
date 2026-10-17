// 模型调用失败的取证日志（2026-10-17）。
//
// 为什么要有它：用户报「deepseek 模型 400」，但会话存储里只留下 errorMessage 摘要，
// 上游原文（比如 "Invalid max_tokens value, the valid range is [1, 393216]"）常常丢失，
// 复现全靠运气。这里把「请求形状 + 上游原文」打成一行 JSON 落到 server 日志，
// 下次再出现同类问题可以直接定位，而不是靠猜。
//
// 只在最终失败点调用（重试/降级都试过之后），不影响正常请求路径。

const SECRET = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g
const MAX_UPSTREAM = 800

export function redactSecrets(text) {
  return String(text ?? "").replace(SECRET, (m) => (m.startsWith("Bearer") ? "Bearer ***" : "sk-***"))
}

/**
 * @param {{ where?: string, model?: { provider?: string, id?: string }, status?: number,
 *           body?: string, request?: Record<string, unknown> }} input
 * @returns {string} the emitted line (also useful in tests)
 */
export function logModelFailure({ where = "", model = null, status = 0, body = "", request = null } = {}) {
  const upstream = redactSecrets(body).slice(0, MAX_UPSTREAM)
  const line = {
    at: new Date().toISOString(),
    where,
    provider: model?.provider ?? null,
    model: model?.id ?? null,
    status,
    request,
    upstream,
  }
  const text = `[model-failure] ${JSON.stringify(line)}`
  try { console.error(text) } catch {}
  return text
}
