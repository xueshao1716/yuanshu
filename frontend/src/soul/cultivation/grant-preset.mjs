// 一次性放权的唯一预设：页面「授权与资源」与对话里的浮动授权弹窗共用，避免两处数字各写各的。
// 范围：七天、最多一个个体、每天 5 次文本请求、每天最多 0.50 美元；不含工具、电脑、文件、私人记忆。
export const GRANT_DAYS = 7;
export const GRANT_DAILY_REQUESTS = 5;
export const GRANT_DAILY_BUDGET_CENTS = 50;
export const GRANT_SCOPE = 'knowledge:approved-cultivation';
// 预检里这些字段由放权本身写入或由放权后小语改一个布尔值解决；剩下只要不出现别的项，按钮就该可点。
export const GRANTABLE_FIELDS = ['policy.enabled', 'policy.expiresAt', 'policy.models', 'policy.tools', 'policy.dataScopes',
  'policy.allowRemote', 'policy.dailyRequests', 'policy.dailyBudgetCents', 'policy.timeoutMs', 'design.remote', 'design.permissions.remote'];
// 共享模型两项缺口可以在同一次确认里补齐：白名单加入设计模型、模型价格已按目录核对。
export const SHARED_FIELDS = ['knowledge.allowedModels', 'knowledge.rates', 'knowledge.rates.tokenBound', 'knowledge.outputTokens'];
// 2026-10-07 真机：推理模型（step-5-preview）1200 输出额度全被思考吃光、60 秒内写不完。
// 与服务端 provider.mjs 的 REASONING_MIN_* 同值：输出至少 4096，单次超时 180 秒（服务端下限 120 秒，留余量）。
export const REASONING_OUTPUT_TOKENS = 4096;
export const GRANT_TIMEOUT_MS = 180000;

export const grantSummary = `${GRANT_DAYS} 天、最多一个个体、每天 ${GRANT_DAILY_REQUESTS} 次文本请求、每天最多 ${(GRANT_DAILY_BUDGET_CENTS / 100).toFixed(2)} 美元`;

export function supportedDesign(design) {
  const p = design?.permissions;
  return !!p && p.tools.length === 0 && p.costUpperBoundCents <= GRANT_DAILY_BUDGET_CENTS && p.dataScopes.every(s => s === GRANT_SCOPE);
}

export function grantPolicy(design, now = Date.now()) {
  return {
    enabled: true, maxAgents: 1, maxConcurrent: 1, dailyRequests: GRANT_DAILY_REQUESTS, dailyBudgetCents: GRANT_DAILY_BUDGET_CENTS, currency: 'USD',
    allowRemote: true, recursive: false, models: [design.permissions.model], tools: [], dataScopes: [GRANT_SCOPE],
    expiresAt: new Date(now + GRANT_DAYS * 86400000).toISOString(), timeoutMs: GRANT_TIMEOUT_MS, motherLearning: false,
    schedule: { timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 },
  };
}

// 预检结果分三类：放权能修的、共享设置能顺手修的、修不了的。
export function classifyBlocked(blockedBy, { includeShared = false } = {}) {
  const fixable = [], shared = [], stubborn = [];
  for (const b of blockedBy || []) {
    if (GRANTABLE_FIELDS.includes(b.field)) fixable.push(b);
    else if (includeShared && SHARED_FIELDS.includes(b.field)) shared.push(b);
    else stubborn.push(b);
  }
  return { fixable, shared, stubborn };
}

// 共享设置补丁：只加设计模型进白名单；价格只在目录明确为 0 时标记免费，否则不猜，交回人工填写。
export function sharedPatch(knowledgePolicy, model, catalogCost, { reasoning = false } = {}) {
  if (!knowledgePolicy || !model) return null;
  const patch = {};
  if (reasoning && !(knowledgePolicy.outputTokens >= REASONING_OUTPUT_TOKENS)) patch.outputTokens = REASONING_OUTPUT_TOKENS;
  if (!knowledgePolicy.allowedModels.includes(model)) patch.allowedModels = [...knowledgePolicy.allowedModels, model];
  const rate = knowledgePolicy.rates?.[model];
  const priced = !!rate && (rate.free === true || (Number.isFinite(rate.input) && Number.isFinite(rate.output))) && rate.tokenBound === 'utf8-bytes';
  if (!priced) {
    if (!(catalogCost && catalogCost.input === 0 && catalogCost.output === 0)) return { needsManualPrice: true, patch };
    patch.rates = { ...knowledgePolicy.rates, [model]: { input: 0, output: 0, currency: knowledgePolicy.currency || 'USD', free: true, tokenBound: 'utf8-bytes' } };
  }
  return { needsManualPrice: false, patch: Object.keys(patch).length ? patch : null };
}
