import { effectiveCapabilities } from '../shared/model-capabilities.mjs';

export const explicitStoryModel = model => Boolean(model?.id && model.id !== 'auto' && model.provider !== 'auto');
export const supportsStoryKind = (model, kind) => Boolean(model?.id && model.enabled !== false && effectiveCapabilities(model)[kind === 'novel' ? 'chat' : kind]);
const normalized = model => model ? { ...model, capabilities: effectiveCapabilities(model) } : model;

// Catalog-backed requests cannot override capability flags or resurrect removed models.
// Standalone adapters without a catalog retain their existing injection contract.
export function resolveStoryModel({ explicit, kind, getModelList, getDefaultModel, fallback }) {
  const hasCatalog = typeof getModelList === 'function';
  const available = hasCatalog ? getModelList() : [];
  if (explicitStoryModel(explicit)) {
    const selected = hasCatalog ? available.find(m => m.provider === explicit.provider && m.id === explicit.id) : explicit;
    if (hasCatalog && !supportsStoryKind(selected, kind)) {
      throw Object.assign(new Error('所选模型已移除、停用或不支持当前输出类型，请重新选择模型'), { statusCode: 400 });
    }
    return hasCatalog ? normalized(selected) : selected;
  }
  const rank = m => /3\.|latest|pro/i.test(m.id) ? 0 : /2\.5/.test(m.id) ? 1 : /2\.1/.test(m.id) ? 2 : /2\.0/.test(m.id) ? 3 : 4;
  const selected = available.filter(m => supportsStoryKind(m, kind)).sort((a, b) => rank(a) - rank(b))[0];
  if (selected) return normalized(selected);
  if (hasCatalog) throw Object.assign(new Error('没有支持当前输出类型的可用模型，请先到模型管理配置'), { statusCode: 503 });
  return typeof getDefaultModel === 'function' ? getDefaultModel() : fallback;
}

export function storyTextCandidates({ explicit, getModelList, getDefaultModel }) {
  if (explicitStoryModel(explicit)) return [resolveStoryModel({ explicit, kind: 'novel', getModelList, getDefaultModel })];
  const hasCatalog = typeof getModelList === 'function';
  const available = hasCatalog ? getModelList().filter(m => supportsStoryKind(m, 'novel')) : [];
  const preferred = typeof getDefaultModel === 'function' ? getDefaultModel() : null;
  const fallback = hasCatalog ? available.find(m => m.provider === preferred?.provider && m.id === preferred?.id) : preferred;
  const fast = available.find(m => !m.reasoning && /agnes-3\.0-flash/i.test(m.id)) || available.find(m => !m.reasoning);
  return [fast, fallback, ...available].filter((m, i, all) => m?.id && all.findIndex(x => x?.provider === m.provider && x?.id === m.id) === i).map(normalized);
}
