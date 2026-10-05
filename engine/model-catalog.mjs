import { effectiveCapabilities } from '../shared/model-capabilities.mjs';

// Startup and credential refresh must expose the same enabled, normalized catalog.
export function buildModelCatalog({ store = {}, authed = new Set(), runtimeModels = [], keepModels = new Set() }) {
  const all = [];
  const add = (provider, m) => {
    if (!m?.id || m.enabled === false) return;
    all.push({ provider, id: m.id, name: m.name || m.id, api: m.api, baseUrl: m.baseUrl,
      reasoning: !!m.reasoning, contextWindow: m.contextWindow, input: m.input,
      compat: m.compat, thinkingLevelMap: m.thinkingLevelMap, capabilities: effectiveCapabilities(m),
      // 目录价格（每百万 token）只透传有限数字；共享设置据此判断能否标记免费，缺失就交回人工。
      ...(Number.isFinite(m.cost?.input) && Number.isFinite(m.cost?.output) ? { cost: { input: m.cost.input, output: m.cost.output } } : {}) });
  };
  for (const m of runtimeModels) {
    if (authed.has(m.provider) && !store[m.provider]) add(m.provider, m);
  }
  for (const [provider, cfg] of Object.entries(store)) {
    if (authed.has(provider)) for (const m of cfg.models || []) add(provider, m);
  }
  return all.filter(m => !['deepseek', 'openai', 'openrouter'].includes(m.provider)
    || store[m.provider]?.managedCatalog || keepModels.has(`${m.provider}/${m.id}`));
}
