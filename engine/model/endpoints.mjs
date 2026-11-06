// One URL policy for discovery, verification and invocation. Explicit paths are authoritative.
export function normalizeModelBase(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Base URL 必须是完整的 http(s) 地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 仅支持 http(s)，不能包含账号、密码、查询参数或片段');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|messages|responses|models)$/, '').replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}
export function modelEndpoint(base, endpoint) {
  const clean = normalizeModelBase(base);
  const url = new URL(clean);
  return `${clean}${url.pathname === '/' || !url.pathname ? '/v1' : ''}/${endpoint}`;
}
export function catalogHeaders(key, api) {
  return api === 'anthropic-messages'
    ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
}
export function modelProbeError(status = 0, code = '') {
  const reasons = { 401: '上游拒绝鉴权，请检查 API Key、协议和该接口权限；目录被拒绝不代表模型无法调用', 403: '该 Key 没有访问权限，请检查平台授权或地区限制',
    404: '接口不存在，请检查 Base URL 和协议；若不支持模型列表，可手动填写模型 ID',
    429: '上游限流或额度不足，请检查余额并稍后重试；不代表模型不支持',
    400: '上游拒绝请求，请检查协议、模型 ID 和平台参数要求',
    405: '该接口不支持此请求，请检查 Base URL 和协议' };
  const message = code === 'invalid_response' ? '响应不是有效的模型数据，请检查是否填入了网页地址、代理错误页或不匹配的协议'
    : code === 'empty_catalog' ? '列表中没有有效模型 ID；可检查权限或手动填写模型 ID'
    : code === 'timeout' ? '探测超时，请检查网络、代理或稍后重试'
    : reasons[status] || (status ? '上游服务异常，请稍后重试' : '无法连接上游，请检查地址、网络和代理');
  return Object.assign(new Error(`${message}${status ? `（HTTP ${status}）` : ''}`), { status, code });
}
