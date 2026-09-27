import { catalogModel, discoverCustomModels } from './model-probe.mjs';
import { normalizeModelBase } from './model-endpoints.mjs';
import { verifyTextModel } from './model-verification.mjs';

const invalid = message => Object.assign(new Error(message), { localStatus: 400 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createModelOnboarding({ read, write, authPath, modelsPath, refresh, presets, json, syncDsh }) {
  function persist(file, value) {
    try { if (write(file, value) !== false) return; } catch {}
    throw Object.assign(new Error('配置写入失败，请检查磁盘空间和文件权限后重试'), { localStatus: 500 });
  }
  function settings(body) {
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(provider) || ['__proto__', 'prototype', 'constructor'].includes(provider)) throw invalid('服务商名称只能包含字母、数字、横线和下划线');
    const auth = read(authPath)[provider], cfg = read(modelsPath)[provider] || {};
    const suppliedKey = body.apiKey ?? body.key;
    const key = typeof suppliedKey === 'string' && suppliedKey.trim() ? suppliedKey.trim() : auth?.key;
    if (!key) throw invalid('请填写 API Key');
    if (/[^\x21-\x7E]/.test(key)) throw invalid('API Key 包含空格或特殊字符，请重新复制密钥');
    const previousApi = cfg.api || cfg.models?.[0]?.api || presets[provider]?.api || (provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions');
    const api = body.api || previousApi;
    if (!['openai-completions', 'anthropic-messages'].includes(api)) throw invalid('接入支持 OpenAI Chat 和 Anthropic Messages 协议，请选择对应协议');
    const rawBase = body.baseUrl?.trim() || cfg.baseUrl || cfg.models?.[0]?.baseUrl || auth?.baseUrl || presets[provider]?.baseUrl;
    const baseUrl = provider === 'cloudflare-ai' ? '' : normalizeModelBase(rawBase);
    const account_id = body.account_id || auth?.account_id;
    if (provider === 'cloudflare-ai' && !/^[a-zA-Z0-9]{16,64}$/.test(account_id || '')) throw invalid('Cloudflare 需要有效的 Account ID');
    const ids = body.modelIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 512))) throw invalid('模型 ID 必须是非空文本列表，最多 200 项');
    return { provider, auth, cfg, key, api, previousApi, baseUrl, account_id, ids: [...new Set((ids || []).map(id => id.trim()))] };
  }
  async function discover(s) {
    if (s.provider === 'cloudflare-ai') return [catalogModel('@cf/black-forest-labs/flux-1-schnell', '', s.api, 'FLUX.1 Schnell', 'manual')].map(m => ({ ...m, capabilities: { chat: false, image: true } }));
    if (s.ids.length) return s.ids.map(id => catalogModel(id, s.baseUrl, s.api, id, 'manual'));
    return discoverCustomModels(s.baseUrl, s.key, new Map(), { api: s.api });
  }
  function failure(res, error) {
    // Upstream 401 must not masquerade as a Yuanshu login failure.
    return json(res, error.localStatus || (error.status ? 422 : 400), { error: error.message, upstreamStatus: error.status || null, saved: false });
  }
  async function preview(res, body) {
    try {
      const s = settings(body), models = await discover(s);
      return json(res, 200, { models: models.map(m => ({ id: m.id, name: m.name })), modelCount: models.length, api: s.api, baseUrl: models[0]?.baseUrl || s.baseUrl, source: s.ids.length ? 'manual' : 'catalog', saved: false });
    } catch (e) { return failure(res, e); }
  }
  async function add(res, body) {
    let saved = false;
    try {
      const s = settings(body), discovered = await discover(s);
      const auth = read(authPath), store = read(modelsPath);
      if (!same(auth[s.provider], s.auth) || !same(store[s.provider] || {}, s.cfg)) throw invalid('配置在探测期间已变更，请刷新后重试');
      const old = new Map((s.cfg.models || []).map(m => [m.id, m]));
      const oldBase = s.cfg.baseUrl || s.cfg.models?.[0]?.baseUrl || s.auth?.baseUrl;
      const sameBase = oldBase && normalizeModelBase(oldBase) === s.baseUrl;
      const sameCredentials = sameBase && s.auth?.key === s.key;
      const changedApi = Boolean(body.api && body.api !== s.previousApi);
      const models = discovered.map(m => {
        const previous = old.get(m.id);
        if (!previous) return m;
        const merged = { ...m, ...previous, discoverySource: m.discoverySource,
          baseUrl: sameBase ? previous.baseUrl || m.baseUrl : m.baseUrl,
          api: changedApi ? s.api : previous.api || m.api };
        if (!sameCredentials || changedApi) delete merged.verification;
        return merged;
      });
      // Refresh is additive: preserve manually curated IDs and metadata when catalogs omit them.
      for (const m of old.values()) if (!models.some(n => n.id === m.id)) {
        const retained = { ...m, ...(sameBase ? {} : { baseUrl: s.baseUrl }), ...(changedApi ? { api: s.api } : {}) };
        if (!sameCredentials || changedApi) delete retained.verification;
        models.push(retained);
      }
      auth[s.provider] = { ...s.auth, type: 'api_key', key: s.key, baseUrl: s.baseUrl, ...(s.account_id ? { account_id: s.account_id } : {}) };
      store[s.provider] = { ...s.cfg, models, api: s.api, baseUrl: s.baseUrl, managedCatalog: true, checkedAt: new Date().toISOString() };
      try { persist(modelsPath, store); persist(authPath, auth); }
      catch (error) {
        const rollbackStore = read(modelsPath), rollbackAuth = read(authPath);
        if (Object.keys(s.cfg).length) rollbackStore[s.provider] = s.cfg; else delete rollbackStore[s.provider];
        if (s.auth) rollbackAuth[s.provider] = s.auth; else delete rollbackAuth[s.provider];
        try { write(modelsPath, rollbackStore); write(authPath, rollbackAuth); } catch {}
        throw error;
      }
      saved = true;
      await refresh();
      const dsh = body.toDsh ? syncDsh(s.key) : { dsh: false, dshNote: '' };
      return json(res, 200, { ok: true, saved: true, pi: s.provider, provider: s.provider, modelCount: models.length, discoveredCount: discovered.length,
        models: models.map(m => m.id), manual: s.ids.length > 0 || s.provider === 'cloudflare-ai', ...dsh });
    } catch (e) {
      if (saved) return json(res, 200, { ok: true, saved: true, warning: '配置已保存，但运行列表刷新失败，请刷新页面或重启服务后重试' });
      return failure(res, e);
    }
  }
  async function verify(res, body) {
    try {
      const provider = body?.provider, id = body?.modelId;
      if (typeof provider !== 'string' || typeof id !== 'string') throw invalid('请选择要验证的模型');
      const auth = read(authPath)[provider], cfg = read(modelsPath)[provider];
      const model = cfg?.models?.find(m => m.id === id);
      if (!model || !auth?.key) throw invalid('模型或密钥不存在，请先保存接入配置');
      const result = await verifyTextModel({ ...model, provider, api: model.api || cfg.api, baseUrl: model.baseUrl || cfg.baseUrl || auth.baseUrl }, auth.key);
      const current = read(modelsPath), currentAuth = read(authPath)[provider];
      if (!same(current[provider], cfg) || !same(currentAuth, auth)) throw invalid('配置在验证期间已变更，请重新验证');
      current[provider].models.find(m => m.id === id).verification = result;
      persist(modelsPath, current);
      return json(res, 200, result);
    } catch (e) { return failure(res, e); }
  }
  return { add, preview, verify };
}
