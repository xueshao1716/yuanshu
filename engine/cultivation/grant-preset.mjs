// 一次性放权的唯一预设：页面「授权与资源」与对话里的浮动授权弹窗共用，避免两处数字各写各的。
// 2026-10-14 伙伴「培养体系可以复杂，授权一定要简单；元枢自己培养，给最大自由度」：封套放宽到 30 天、10 个个体、每天 300 次、每天 10 美元、单次 10 分钟。
// 2026-10-15 伙伴「培养体系你设计的，把权放开」：封套再放宽到 90 天、20 个个体（并发 4）、每天 1000 次、每天 50 美元，并允许母体学习；都是 policy.mjs 的硬上限内。
// 仍不含工具、电脑、文件、私人记忆，这是红线，放大的只是时间与额度。
export const GRANT_DAYS = 90;
export const GRANT_MAX_AGENTS = 20;
export const GRANT_MAX_CONCURRENT = 4;
export const GRANT_DAILY_REQUESTS = 1000;
export const GRANT_DAILY_BUDGET_CENTS = 5000;
// 共享后台（知识 + 培养）每天模型调用总数；低于它时培养的每日次数会被共享上限先卡住。
export const SHARED_MODEL_REQUESTS = 1500;
export const GRANT_SCOPE = 'knowledge:approved-cultivation';
// 预检里这些字段由放权本身写入或由放权后小语改一个布尔值解决；剩下只要不出现别的项，按钮就该可点。
export const GRANTABLE_FIELDS = ['policy.enabled', 'policy.expiresAt', 'policy.models', 'policy.tools', 'policy.dataScopes',
  'policy.allowRemote', 'policy.dailyRequests', 'policy.dailyBudgetCents', 'policy.timeoutMs', 'policy.maxAgents', 'design.remote', 'design.permissions.remote'];
// 共享模型两项缺口可以在同一次确认里补齐：白名单加入设计模型、模型价格已按目录核对。
export const SHARED_FIELDS = ['knowledge.allowedModels', 'knowledge.rates', 'knowledge.rates.tokenBound', 'knowledge.outputTokens'];
// 2026-10-07 真机：推理模型（step-5-preview）1200 输出额度全被思考吃光、60 秒内写不完。
// 与服务端 provider.mjs 的 REASONING_MIN_* 对齐：输出至少 4096，单次超时不低于服务端下限 120 秒。
export const REASONING_OUTPUT_TOKENS = 4096;
// 2026-10-07：单次超时放到服务端允许的上限 10 分钟（policy.mjs timeoutMs ≤ 600000）。
export const GRANT_TIMEOUT_MS = 600000;

export const grantSummary = `${GRANT_DAYS} 天、最多 ${GRANT_MAX_AGENTS} 个个体、单次 ${GRANT_TIMEOUT_MS / 60000} 分钟、每天 ${GRANT_DAILY_REQUESTS} 次文本请求、每天最多 ${(GRANT_DAILY_BUDGET_CENTS / 100).toFixed(2)} 美元`;

export function supportedDesign(design) {
  const p = design?.permissions;
  return !!p && p.tools.length === 0 && p.costUpperBoundCents <= GRANT_DAILY_BUDGET_CENTS && p.dataScopes.every(s => s === GRANT_SCOPE);
}

export function grantPolicy(design, now = Date.now()) {
  return {
    enabled: true, maxAgents: GRANT_MAX_AGENTS, maxConcurrent: GRANT_MAX_CONCURRENT, dailyRequests: GRANT_DAILY_REQUESTS, dailyBudgetCents: GRANT_DAILY_BUDGET_CENTS, currency: 'USD',
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

// 2026-10-07 伙伴要更大额度：已开启的授权就地放大，只动时间与额度，模型、工具、数据范围、母体学习原样保留。
// 返回 null 表示已经不低于预设，不用再弹确认。
export function widenPolicy(policy, now = Date.now()) {
  if (!policy?.enabled) return null;
  const expiry = Date.parse(policy.expiresAt);
  const target = now + GRANT_DAYS * 86400000;
  const next = {
    ...policy,
    maxAgents: Math.max(policy.maxAgents ?? 1, GRANT_MAX_AGENTS),
    dailyRequests: Math.max(policy.dailyRequests ?? 0, GRANT_DAILY_REQUESTS),
    dailyBudgetCents: Math.max(policy.dailyBudgetCents ?? 0, GRANT_DAILY_BUDGET_CENTS),
    timeoutMs: Math.max(policy.timeoutMs ?? 60000, GRANT_TIMEOUT_MS),
    expiresAt: Number.isFinite(expiry) && expiry >= target ? policy.expiresAt : new Date(target).toISOString(),
  };
  const changed = ['maxAgents', 'dailyRequests', 'dailyBudgetCents', 'timeoutMs', 'expiresAt'].filter(k => next[k] !== policy[k]);
  // 有效期只差几小时不算缺口，避免每次打开都提示。
  const meaningful = changed.filter(k => k !== 'expiresAt' || !(Number.isFinite(expiry) && target - expiry < 86400000));
  return meaningful.length ? { policy: next, changed: meaningful } : null;
}

// 共享后台每天模型调用总数不足时的补丁；够了返回 null。
export function sharedRequestPatch(knowledgePolicy) {
  if (!knowledgePolicy || !(knowledgePolicy.maxModelRequests < SHARED_MODEL_REQUESTS)) return null;
  return { maxModelRequests: SHARED_MODEL_REQUESTS };
}

// ── 灵魂自我驱动边界的封套（2026-10-11 伙伴要求："灵魂自己驱动边界，不给用户一堆选择"）──
// 小语可以**自行**开启/续期这个受限封套，不需要人工确认卡；一旦想越过任何一条红线（加工具、
// 放开母体学习、写宽费用/次数/个体数、拖长有效期、扩大数据范围），就必须回到人工授权。
// 服务器在 commandKinds 里用同一份判定，别在前端另写第二份。
export function isBoundedPresetPolicy(policy, now = Date.now()) {
  if (!policy || typeof policy !== 'object') return false;
  if (policy.enabled !== true || policy.recursive !== false || (policy.motherLearning !== undefined && typeof policy.motherLearning !== 'boolean')) return false;
  if (Array.isArray(policy.tools) && policy.tools.length) return false;
  if (Array.isArray(policy.dataScopes) && policy.dataScopes.some(s => s !== GRANT_SCOPE)) return false;
  if (!Array.isArray(policy.models) || policy.models.length < 1 || policy.models.length > 8) return false;
  const n = v => (typeof v === 'number' && Number.isSafeInteger(v)) ? v : -1;
  if ((n(policy.maxAgents) < 0 ? policy.maxAgents ?? 3 : policy.maxAgents) > GRANT_MAX_AGENTS) return false;
  if (policy.maxConcurrent !== undefined && (n(policy.maxConcurrent) < 0 || policy.maxConcurrent > GRANT_MAX_CONCURRENT)) return false;
  if (n(policy.dailyRequests) > GRANT_DAILY_REQUESTS) return false;
  if (n(policy.dailyBudgetCents) > GRANT_DAILY_BUDGET_CENTS) return false;
  if (policy.timeoutMs !== undefined && (n(policy.timeoutMs) < 0 || policy.timeoutMs > GRANT_TIMEOUT_MS)) return false;
  const t = Date.parse(policy.expiresAt);
  if (!Number.isFinite(t)) return false;
  if (t <= (typeof now === 'function' ? now() : now)) return false;
  if (t > (typeof now === 'function' ? now() : now) + GRANT_DAYS * 86400000) return false;
  return true;
}
// 自我刹车：停用是收紧方向，小语可以自己暂停，但不能改任何放权参数之外的扩张
export function isPresetPausePolicy(policy) {
  return !!policy && typeof policy === 'object' && policy.enabled === false &&
    policy.motherLearning === false && policy.recursive === false &&
    Array.isArray(policy.tools) && policy.tools.length === 0;
}
