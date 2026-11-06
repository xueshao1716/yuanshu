// Passive, process-local evidence only. No probes, credentials or request/response bodies.
const descriptions = {
  auth_failed: '上游拒绝密钥，请检查该通道的凭据。',
  access_denied: '上游拒绝访问，请检查账号分组和模型权限。',
  payment_required: '上游要求付费，请核对账户余额或套餐。',
  rate_limited: '上游限流，请稍后再试并核对通道额度。',
  not_found: '上游未找到接口或模型，请核对协议与模型标识。',
  invalid_request: '上游拒绝请求参数，请核对模型支持的输入。',
  upstream_error: '上游服务异常，请稍后查询原任务，避免重复提交。',
  timeout: '请求超时，结果尚不确定；请先查询原任务，避免重复提交。',
  network_error: '网络连接失败，结果尚不确定；请核对连接和原任务。',
  invalid_response: '上游响应缺少有效媒体结果，请核对模型协议。',
  generation_failed: '上游报告生成失败，请查看原任务。',
  request_failed: '调用未完成，原因尚未确认；请先核对原任务。',
};
const safeId = value => typeof value === 'string' && value.length <= 120
  && /^[\p{L}\p{N}@][\p{L}\p{N}@._/-]*$/u.test(value)
  && !/(?:^|[/])(?:sk-|bearer)|\.\.|^[/]|:\/\//i.test(value) ? value : '[redacted]';
function category(status, code) {
  if (status === 401) return 'auth_failed';
  if (status === 403) return 'access_denied';
  if (status === 402) return 'payment_required';
  if (status === 429) return 'rate_limited';
  if ([408,504,522,524].includes(status)) return 'timeout';
  if ([404,405,501].includes(status)) return 'not_found';
  if (status >= 500) return 'upstream_error';
  if (status >= 400) return 'invalid_request';
  return Object.hasOwn(descriptions, code) ? code : 'request_failed';
}
export function createMediaObservations({limit = 80, now = Date.now} = {}) {
  const capacity = Number.isInteger(limit) ? Math.max(1, Math.min(80,limit)) : 80;
  const startedAt = new Date(now()).toISOString();
  let items = [], sequence = 0;
  const prune = () => { const cutoff = now() - 86400000; items = items.filter(x => Date.parse(x.at) >= cutoff); };
  return {
    record(input = {}) {
      if (!['image','video','tts'].includes(input.kind)) return;
      const status = Number.isInteger(input.status) && input.status >= 400 && input.status <= 599 ? input.status : null;
      const code = category(status,input.code);
      prune();
      items.unshift({id:++sequence, at:new Date(now()).toISOString(), kind:input.kind,
        provider:safeId(input.provider), model:safeId(input.model),
        phase:['generate','create','poll','reply','reply_stream'].includes(input.phase)?input.phase:'generate',
        status, code, message:descriptions[code]});
      items = items.slice(0,capacity);
    },
    snapshot() { prune(); return {scope:'process',startedAt,maxItems:capacity,retentionHours:24,items:items.map(x=>({...x}))}; },
  };
}
export const mediaObservations = createMediaObservations();
export function recordMediaFailure(context, result) {
  // Observation failure must never change a purchase or cause a retry.
  try { (context.store || mediaObservations).record({...context,...result}); } catch { /* best effort */ }
}
export async function readMediaJson(context, response) {
  try {
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid media response');
    return data;
  } catch (error) {
    recordMediaFailure(context,{code:'invalid_response'});
    throw error;
  }
}
export async function observeMediaRequest(context, request) {
  try {
    const response = await request();
    if (response?.ok === false) recordMediaFailure(context,{status:response.status});
    return response;
  } catch (error) {
    if (!context.signal?.aborted && error?.name !== 'AbortError') {
      const code = ['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','TOOL_TIMEOUT'].includes(error?.code) || error?.message === 'timeout' || error?.name === 'TimeoutError' ? 'timeout'
        : ['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN'].includes(error?.code || error?.cause?.code) || error?.message === 'fetch failed' ? 'network_error' : 'request_failed';
      recordMediaFailure(context,{code});
    }
    throw error;
  }
}
