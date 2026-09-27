import { httpJsonFetch, sessionAffinityHeaders } from './http.mjs';
import { catalogHeaders, modelEndpoint, normalizeModelBase, modelProbeError } from './model-endpoints.mjs';
import { maxTokensFieldOf } from './output-budget.mjs';

// Explicit, bounded text check only. Never silently switches model or generates media.
export async function verifyTextModel(model, key, { httpFetch = httpJsonFetch, timeoutMs = 15000 } = {}) {
  const started = Date.now(), api = model.api || 'openai-completions';
  const common = { api, requestedModel: model.id, checkedAt: new Date().toISOString() };
  try {
    if (!key) throw new Error('没有配置 API Key');
    if (!['openai-completions', 'anthropic-messages', 'openai-responses'].includes(api)) throw new Error(`暂不支持 ${api} 的独立文本验证，请用实际会话验证`);
    if (model.capabilities?.chat === false) throw new Error('这是媒体模型，请在对应创作工具中验证；此处不会自动生成图片、视频或音频');
    const responses = api === 'openai-responses';
    const endpoint = api === 'anthropic-messages' ? 'messages' : responses ? 'responses' : 'chat/completions';
    const body = responses ? { model: model.id, input: 'Reply with OK.', max_output_tokens: 64, stream: false }
      : { model: model.id, messages: [{ role: 'user', content: 'Reply with OK.' }], [api === 'anthropic-messages' ? 'max_tokens' : maxTokensFieldOf(model.compat)]: 64, stream: false };
    const request = { method: 'POST', timeout: timeoutMs,
      headers: { ...catalogHeaders(key, api), ...sessionAffinityHeaders({ provider: model.provider, compat: model.compat }) }, body: JSON.stringify(body) };
    let r = await httpFetch(modelEndpoint(model.baseUrl, endpoint), request);
    if (r.status === 404 && new URL(normalizeModelBase(model.baseUrl)).pathname === '/') {
      r = await httpFetch(`${normalizeModelBase(model.baseUrl)}/${endpoint}`, { ...request, timeout: Math.max(1, timeoutMs - (Date.now() - started)) });
    }
    if (!r.ok) throw modelProbeError(r.status);
    const data = await r.json();
    const content = api === 'anthropic-messages' ? data?.content?.filter(b => b.type === 'text').map(b => b.text).join('')
      : responses ? data?.output?.flatMap(b => b.content || []).filter(b => b.type === 'output_text').map(b => b.text).join('')
      : data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      if (data?.stop_reason === 'max_tokens' || data?.choices?.[0]?.finish_reason === 'length' || data?.incomplete_details?.reason === 'max_output_tokens') {
        return { ...common, ok: false, status: 'inconclusive', latencyMs: Date.now() - started,
          message: '上游接受了请求，但短文本预算已耗尽；未能验证完整回答，请通过实际会话确认' };
      }
      throw modelProbeError(0, 'invalid_response');
    }
    return { ...common, ok: true, status: 'verified', latencyMs: Date.now() - started, reportedModel: typeof data.model === 'string' ? data.model : null,
      message: '已收到文本回答；工具、视觉及媒体能力尚未验证' };
  } catch (error) {
    const safe = error?.name === 'AbortError' || /timeout/i.test(error?.message || '') ? modelProbeError(0, 'timeout') : error;
    return { ...common, ok: false, status: 'failed', latencyMs: Date.now() - started, httpStatus: safe.status || null,
      message: safe.status !== undefined || /^(没有配置|暂不支持|这是媒体|Base URL)/.test(safe.message || '') ? safe.message : modelProbeError().message };
  }
}
