// ===== model-probe.mjs —— 模型能力探测与发现（从 server.mjs 抽离）=====
// 职责：标注能力推断 / 按协议读取模型目录 / 用户主动触发的文本验证，不自动生成媒体。
// 纯逻辑 + engine/http 客户端，无 server 依赖。

import { httpJsonFetch } from "./http.mjs";
import { catalogHeaders, modelEndpoint, normalizeModelBase, modelProbeError } from './model-endpoints.mjs';
import { verifyTextModel } from './model-verification.mjs';

// 按模型 id 关键字推断能力（查档案兜底，不靠真实探测）
export function modelCapabilities(id) {
  const caps = { chat: true, image: false, video: false, tts: false, asr: false };
  if (/image/i.test(id)) { caps.image = true; caps.chat = false; }
  if (/video/i.test(id)) { caps.video = true; caps.chat = false; }
  if (/tts/i.test(id)) { caps.tts = true; caps.chat = false; }
  if (/asr/i.test(id)) { caps.asr = true; caps.chat = false; }
  // 连续性参数（reference/keyframe/seed）——含义是「本管道会把它原样转发给上游」，
  // 不是「上游保证遵守」：
  //   image｜图生图：media-api.generateImage 转发 image + seed + negative_prompt
  //   video｜参考与首尾帧：video-request.videoCreateBody 转发 image/first_frame/last_frame/images[]/videos[]/seed
  // 2026-09-14 之前这三个键从未被任何代码写入，于是 story-orchestrator 的
  // negotiateCapabilities 对**每一个**图像/视频任务都报「当前模型不支持参考资产」——
  // 能力协商层在问一个没人填的字段，用户看到的是假的降级提示，参考图通路也从未打开。
  // 2026-09-15 又发现 seed 是**半根假通路**：键写了、run 里存了、适配器也传了，
  // 但 generateImage 的请求体里没有它，视频适配器压根没解构它——声称支持却从未生效。
  // 现在两条通道都真的上送，capability 这句话才算成立。
  if (caps.image || caps.video) { caps.reference = true; caps.seed = true; }
  if (caps.video) caps.keyframe = true;
  return caps;
}

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
