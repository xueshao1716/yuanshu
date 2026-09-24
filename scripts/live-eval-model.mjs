import fs from 'node:fs';

// Read-only preflight. Never put the host token in a URL, redirect or report.
export async function loadLiveEvalModel({ tokenFile, requestedModel,
  baseUrl = 'http://127.0.0.1:8787', fetchImpl = fetch } = {}) {
  const url = new URL('/api/models', baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('验收只允许连接本机服务，不向外部地址发送宿主令牌');
  let token;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); }
  catch { throw new Error('无法读取本机令牌；请设置 YUANSHU_EVAL_TOKEN_FILE'); }
  if (!token) throw new Error('本机令牌为空；请设置 YUANSHU_EVAL_TOKEN_FILE');
  const response = await fetchImpl(url.href, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`模型列表请求失败 HTTP ${response.status}；请检查现用服务及 YUANSHU_EVAL_TOKEN_FILE`);
  }
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data?.models)) throw new Error('服务返回的模型列表格式不正确，未调用付费模型');
  const model = data.models.find(m => requestedModel ? `${m.provider}/${m.id}` === requestedModel
    : m.provider === data.current?.provider && m.id === data.current?.id);
  if (!model) throw new Error('指定或当前文本模型不可用，未静默切换模型');
  return model;
}
