// model-probe.mjs —— 模型通断探测（2026-08-21）
// 用户理念落地：模型故障（429/400/403）时，不再"固定链跳过冷却"，而是主动探测候选模型
// （短文本请求），直到拿到第一个实际返回文本的候选。
import { verifyTextModel } from './model-verification.mjs';
let _httpFetch = null;
let _authReader = null;   // () => auth.json 对象
let _modelsReader = null; // () => models-store 对象
let _getModelList = () => [];

export function initModelProbe({ httpFetch = null, authReader = null, modelsReader = null, getModelList = null } = {}) {
  if (httpFetch) _httpFetch = httpFetch;
  if (authReader) _authReader = authReader;
  if (modelsReader) _modelsReader = modelsReader;
  if (getModelList) _getModelList = getModelList;
}

/**
 * 探测单个模型：成功响应且包含文本才视为通过。
 * @returns {Promise<boolean>} 当前文本调用是否成功
 */
export async function probeModel(model, { timeoutMs = 8000 } = {}) {
  if (!_httpFetch) return false;
  try {
    const auth = _authReader ? _authReader() : {};
    const key = auth[model?.provider]?.key;
    if (!key) return false;
    const store = _modelsReader ? _modelsReader() : {};
    const mdef = (store[model.provider]?.models || []).find((m) => m.id === model.id)
      || _getModelList().find((m) => m.provider === model.provider && m.id === model.id);
    const cfg = store[model.provider] || {};
    const base = mdef?.baseUrl || model.baseUrl || cfg.baseUrl || auth[model.provider]?.baseUrl;
    if (!base) return false;
    const result = await verifyTextModel({ ...model, ...mdef, baseUrl: base, api: mdef?.api || model.api || cfg.api }, key, { httpFetch: _httpFetch, timeoutMs });
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * 探测候选链，返回第一个可用的"好模型"（串行探测，命中即停）。
 * @param {Array} candidates 候选模型数组（含 provider/id/baseUrl）
 * @returns {Promise<object|null>}
 */
export async function pickHealthyModel(candidates = []) {
  for (const c of candidates) {
    if (!c) continue;
    if (await probeModel(c)) return c;
  }
  return null;
}
