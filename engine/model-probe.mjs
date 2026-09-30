// ===== model-probe.mjs —— 模型能力探测与发现（从 server.mjs 抽离）=====
// 职责：标注能力推断 / 按协议读取模型目录 / 用户主动触发的文本验证，不自动生成媒体。
// 纯逻辑 + engine/http 客户端，无 server 依赖。

import { httpJsonFetch } from "./http.mjs";
import { catalogHeaders, modelEndpoint, normalizeModelBase, modelProbeError } from './model-endpoints.mjs';
import { verifyTextModel } from './model-verification.mjs';
import { modelCapabilities } from '../shared/model-capabilities.mjs';
export { modelCapabilities, effectiveCapabilities } from '../shared/model-capabilities.mjs';

// 按模型 id 关键字推断能力（查档案兜底，不靠真实探测）

// Backward-compatible explicit text probe. Media generation is never a discovery side effect.
export async function probeModelCapabilities(baseUrl, key, modelId, { api = 'openai-completions' } = {}) {
  const result = await verifyTextModel({ id: modelId, baseUrl, api }, key);
  return { ...modelCapabilities(modelId), ...(result.ok ? { chat: true } : {}), verification: result };
}

export function catalogModel(id, baseUrl, api = 'openai-completions', name = id, source = 'catalog') {
  return { id, name, api, baseUrl, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 4096,
    capabilities: modelCapabilities(id), capabilitySource: 'inferred', limitsSource: 'default', discoverySource: source };
}

// Listing is cheap and never proves inference access. Errors are not capability evidence.
export async function discoverCustomModels(base, apiKey, _oldCaps = new Map(), { api = 'openai-completions' } = {}) {
  const normalized = normalizeModelBase(base);
  let endpoint = modelEndpoint(normalized, 'models');
  const models = new Map(), deadline = Date.now() + 20000;
  for (let page = 0; page < 10; page++) {
    let r;
    try {
      r = await httpJsonFetch(endpoint, { headers: catalogHeaders(apiKey, api), timeout: Math.max(1, deadline - Date.now()) });
      // Root-only APIs such as DeepSeek may expose /models without /v1.
      if (r.status === 404 && page === 0 && new URL(normalized).pathname === '/') {
        endpoint = `${normalized}/models`;
        r = await httpJsonFetch(endpoint, { headers: catalogHeaders(apiKey, api), timeout: Math.max(1, deadline - Date.now()) });
      }
    } catch (e) { throw modelProbeError(0, /timeout|abort/i.test(e?.message || '') ? 'timeout' : 'network'); }
    if (!r.ok) throw modelProbeError(r.status);
    const data = await r.json();
    const list = data?.data || data?.models;
    if (!Array.isArray(list)) throw modelProbeError(0, 'invalid_response');
    for (const m of list) {
      const id = typeof m?.id === 'string' ? m.id.trim() : '';
      if (!id || id.length > 512) continue;
      models.set(id, catalogModel(id, endpoint.split('?')[0].replace(/\/models$/, ''), api, m.name || m.display_name || id));
    }
    if (!data.has_more) {
      if (!models.size) throw modelProbeError(0, 'empty_catalog');
      return [...models.values()];
    }
    if (!data.last_id || page === 9 || Date.now() >= deadline) throw Object.assign(new Error('模型列表分页未完成，未保存；请缩小列表或手动填写模型 ID'), { status: 0 });
    const next = new URL(endpoint); next.searchParams.set('after_id', data.last_id); endpoint = next.toString();
  }
}
