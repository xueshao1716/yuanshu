// Apply at the provider boundary, including every tool-loop request of this turn.
export function normalizeSamplingParams(value) {
  const out = {};
  if (Number.isFinite(value?.temperature) && value.temperature >= 0 && value.temperature <= 2) out.temperature = value.temperature;
  if (Number.isFinite(value?.top_p) && value.top_p > 0 && value.top_p <= 1) out.top_p = value.top_p;
  return out;
}

export function samplingPayload(payload, model, value) {
  const params = normalizeSamplingParams(value);
  if (!payload || !Object.keys(params).length) return payload;
  const api = model?.api || '', id = model?.id || '';
  if (api.includes('anthropic')) {
    if (payload.thinking?.type === 'enabled' || payload.thinking?.type === 'adaptive') return payload;
    const next = { ...payload };
    if (params.temperature !== undefined) { next.temperature = Math.min(1, params.temperature); delete next.top_p; }
    else if (params.top_p !== undefined) { next.top_p = params.top_p; delete next.temperature; }
    return next;
  }
  // These reasoning endpoints reject sampling overrides rather than ignoring them.
  if (api.includes('codex') || /^(o[134](?:-|$)|gpt-5(?:-|$))/i.test(id)) return payload;
  if (api.startsWith('openai') || api === 'azure-openai-responses') return { ...payload, ...params };
  return payload; // Unknown provider schemas must not receive guessed fields.
}

export async function withSamplingParams(session, value, operation) {
  const params = normalizeSamplingParams(value);
  if (!Object.keys(params).length) return operation();
  const agent = session?.agent;
  if (!agent) throw new Error('当前模型通道不支持自定义参数，请恢复模型默认后重试。');
  const original = agent.onPayload;
  const hook = async (payload, model) => samplingPayload((await original?.(payload, model)) ?? payload, model, params);
  agent.onPayload = hook;
  try { return await operation(); }
  finally { if (agent.onPayload === hook) agent.onPayload = original; }
}
