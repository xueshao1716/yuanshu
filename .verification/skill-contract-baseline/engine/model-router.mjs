// ══ 模型路由层（2026-08-19 拆模块：从 server.mjs 抽出 + 修正 pro/flash 同源问题）══
// 职责：模型健康冷却（429/402/403 通用）/ 默认模型兜底 / 任务复杂度分类 / Auto 路由 / pro 候选。
// 纯逻辑模块：modelList/defaultModel 通过 initModelRouter 注入 getter（避免值拷贝 stale）。

let _getModelList = () => [];
let _getDefaultModel = () => null;
let _configModel = ""; // CONFIG.model（显式指定默认模型时不用 Auto）

export function initModelRouter({ getModelList, getDefaultModel, configModel = "" }) {
  if (getModelList) _getModelList = getModelList;
  if (getDefaultModel) _getDefaultModel = getDefaultModel;
  _configModel = configModel || "";
}

// ── 模型健康冷却（原 opencode-go 429 机制的泛化，2026-08-20）──
// 任何 provider 的 401/402/403/429/529 错误都可标记；冷却期内候选链自动避开。
// 典型场景：千问 token 计划 403 → 不标记的话每次简单任务都先撞一次墙再靠复读守卫救。
const modelBlockedUntil = new Map();
// 2026-08-21 冷却计数（改进提案数据源）：provider → 命中次数+最近原因
export const cooldownHits = new Map(); // "provider/id" → { until, reason }
let ocGoBlockedUntil = 0; // opencode-go 走全 provider 屏蔽（它的 flash/pro 都在同一套餐里）
const BLOCK_MS_DEFAULT = 30 * 60 * 1000;

export function modelKey(m) { return m ? `${m.provider}/${m.id}` : ""; }

// 2026-08-20 收敛：server.mjs 三处重复的"权限/额度错误 → 标记冷却"判定统一到这里
// （401/402/403/429/529：无权限/余额不足/Access denied/额度耗尽/服务过载 → 一律冷却 30 分钟避开）
export const AUTH_ERROR_CODES = [401, 402, 403, 429, 529];
export function isAuthErrorStatus(status) { return AUTH_ERROR_CODES.includes(Number(status)); }
export function isModelBlocked(m) {
  if (!m) return false;
  if (m.provider === "opencode-go" && Date.now() < ocGoBlockedUntil) return true;
  const cur = modelBlockedUntil.get(modelKey(m));
  return !!(cur && Date.now() < cur.until);
}
export function markModelBlocked(m, { ms = BLOCK_MS_DEFAULT, reason = "" } = {}) {
  if (!m) return;
  if (m.provider === "opencode-go") { // 兼容旧语义：ocGo 标记即整个 provider 冷却
    if (Date.now() < ocGoBlockedUntil) return;
    ocGoBlockedUntil = Date.now() + ms;
    console.log(`[router] ⛔ opencode-go 冷却 ${ms / 60000} 分钟（${String(reason).slice(0, 60)}）`);
    return;
  }
  const key = modelKey(m);
  const cur = modelBlockedUntil.get(key);
  if (cur && Date.now() < cur.until) return; // 已标记，不重复刷日志
  modelBlockedUntil.set(key, { until: Date.now() + ms, reason });
  const hp = cooldownHits.get(m.provider) || { count: 0, reasons: [] };
  hp.count += 1;
  if (hp.reasons.length < 5 && !hp.reasons.includes(reason)) hp.reasons.push(reason);
  cooldownHits.set(m.provider, hp);
  console.log(`[router] ⛔ ${key} 冷却 ${ms / 60000} 分钟（${String(reason).slice(0, 60)}）`);
}
// 重置全部健康状态（模型清单刷新/重新探测后调用，给所有模型一次新机会）
export function resetModelHealth() {
  modelBlockedUntil.clear();
  ocGoBlockedUntil = 0;
}

// 冷却统计（供改进提案分析）
export function getCooldownHits() {
  return [...cooldownHits.entries()].map(([provider, h]) => ({ provider, count: h.count, reasons: h.reasons }));
}

// ── opencode-go 兼容导出（server.mjs 既有调用点继续可用）──
export function isOcGoBlocked() { return Date.now() < ocGoBlockedUntil; }
export function markOcGoBlocked(detail) { markModelBlocked({ provider: "opencode-go", id: "any" }, { reason: detail }); }
// opencode-go 候选（blocked 期间返回 undefined，让路由落到下一顺位）
export function ocGoCandidate(re) {
  return isOcGoBlocked() ? undefined : _getModelList().find(m => m.provider === "opencode-go" && re.test(m.id));
}

// 按 provider+正则找模型，跳过冷却中的（候选链统一走这个，健康过滤不再散落各处）
function findLive(provider, re) {
  const m = _getModelList().find(x => x.provider === provider && re.test(x.id));
  return m && !isModelBlocked(m) ? m : undefined;
}
// 候选链最终兜底：默认模型 → 清单里第一个活着的 → null（绝不返回 undefined）

// defaultModel 兜底（blocked 且 defaultModel 恰为 opencode-go 时换可用通道）
// ⚠️ 成本策略（2026-08-19 用户定）：deepseek 官方涨价贵不用——降级链全走 token 计划免费通道
// ⚠️ 2026-08-20 用户指令：阿里千问下架（403 无权限），flash 主力改商汤；nvidia 兜底换 llama-3.1-8b（gemma 系被 NVIDIA 下架 404）
export function pickFallbackDefault() {
  const defaultModel = _getDefaultModel();
  if (defaultModel && !isModelBlocked(defaultModel)) return defaultModel;
  // 用户定（2026-09-04）：默认模型已指向 Agnes 旗舰；冷却时先落 agnes-flash，再走免费通道
  // 2026-09-09：3.0-flash 发布，作为 2.5 后备位
  return findLive("agnes", /2\.5-flash/i)
    || findLive("agnes", /3\.0-flash/i)
    || findLive("sensenova", /flash-lite/i)
    || findLive("nvidia", /llama-3\.1-8b/i)
    || defaultModel; // 全部冷却时仍返回 defaultModel（宁可重试已知模型，不可无模型可用）
}

// ⚠️ 2026-08-19 修复：复读守卫的兜底必须**排除出问题的模型**（否则复读→兜底还是同款，切换无效）。
// 2026-08-20 修正残留：末位兜底 pickFallbackDefault() 也可能返回被排除模型——现在全链过滤。
export function pickFallbackExcluding(excludeModel) {
  const excludeKey = modelKey(excludeModel);
  // 2026-08-27 调序：ox-alpha 已下架；小米不再优先——商汤 → 智谱glm-flash → 小米
  // （之前只有 flash-lite 兜底，mimo 复读时切去更弱的模型，体验差）
  const cands = [
    findLive("agnes", /2\.5-flash/i),
    findLive("agnes", /3\.0-flash/i),
    findLive("sensenova", /flash-lite/i),
    findLive("zai-coding-cn", /glm-5\.3-flash/i),
    findLive("xiaomi-token-plan-cn", /mimo-v2\.5$/i),
    findLive("nvidia", /llama-3\.1-8b/i),
  ].filter(Boolean).filter(m => modelKey(m) !== excludeKey);
  if (cands[0]) return cands[0];
  const fb = pickFallbackDefault();
  return fb && modelKey(fb) !== excludeKey ? fb : null;
}

export const ROUTER_AUTO = { provider: "auto", id: "auto" };
export function isAutoModel(m) { return !!m && (m.provider === "auto" || m.id === "auto" || m.id === "auto-smart"); }

// 复杂/简单任务关键词表（可扩展；命中均带权重，取累计分与阈值比较）
const ROUTER_COMPLEX_PATTERNS = [
  { w: 2, re: /(重构|重写|架构|设计方案?|系统设计|代码库级|跨模块|多文件|多个文件|整个项目|从零(搭建|实现|开发))/i, label: "代码库级" },
  { w: 2, re: /(单元测试|集成测试|测试用例|调试|排错|性能优化|安全审查|代码审查|评审)/i, label: "测试/审查" },
  { w: 2, re: /(迁移|升级改造|协议|算法|并发|分布式|高可用|缓存策略)/i, label: "深度技术" },
  { w: 1, re: /(实现|开发|编写|构建|搭建|部署|集成|对接)/i, label: "开发" },
  { w: 1, re: /(分析|设计|规划|评估|调研|研究|梳理|总结)/i, label: "分析" },
  { w: 1, re: /(请逐步|一步一步|分步骤|详细说明|深入研究)/i, label: "要求细致" },
  { w: 1, re: /```[\s\S]{200,}```/, label: "大段代码" }, // 大段代码块 = 编码任务
];
const ROUTER_SIMPLE_PATTERNS = [
  { w: 2, re: /^(你好|hi|hello|在吗|早|晚上好|嗨|谢谢|感谢|再见|拜拜)/i, label: "问候" },
  { w: 1, re: /(闲聊|随便聊聊|讲个笑话|笑话|天气|几点|现在几点|周末)/i, label: "闲聊" },
  { w: 1, re: /^(解释|介绍一下|什么是|什么叫|能不能|请问|翻译|帮我算)/, label: "轻问答" },
  { w: 1, re: /^.{0,30}$/, label: "短消息" }, // 极短消息按简单处理（修饰词少，多为闲聊/快问快答）
];
// 任务复杂度分类（规则评分，可解释、零成本、可调阈值）
export function classifyTaskComplexity(text) {
  const t = String(text || "").trim();
  let score = 0; const reasons = [];
  if (t.length > 400) { score += 3; reasons.push("长任务"); }
  else if (t.length > 150) { score += 1; reasons.push("较长"); }
  for (const p of ROUTER_COMPLEX_PATTERNS) { if (p.re.test(t)) { score += p.w; reasons.push(p.label || p.re.source.slice(0, 18)); } }
  for (const p of ROUTER_SIMPLE_PATTERNS) { if (p.re.test(t)) { score -= p.w; reasons.push("-" + (p.label || p.re.source.slice(0, 12))); } }
  const complex = score >= 3;
  return { level: complex ? "complex" : "simple", score, reasons: reasons.slice(0, 5) };
}

// flash 主力候选（2026-08-27 用户定：小米太垃圾不再优先）——
// 商汤 flash-lite（免费实测稳）→ 智谱 glm-5.3-flash（coding 套餐免费）→ 小米 mimo → ocGo flash → nvidia → ark
export function flashCandidate() {
  // 2026-09-09：3.0-flash 发布，挂在 2.5 后备位（2.5 冷却/限流时先落 3.0 再走免费通道）
  return findLive("agnes", /2\.5-flash/i)
    || findLive("agnes", /3\.0-flash/i)
    || findLive("sensenova", /flash-lite/i)
    || findLive("zai-coding-cn", /glm-5\.3-flash/i)
    || findLive("xiaomi-token-plan-cn", /mimo-v2\.5$/i)
    || ocGoCandidate(/deepseek-v4-flash/i)
    || findLive("nvidia", /llama-3\.1-8b/i)
    || pickFallbackDefault();
}
// pro 候选（复杂任务 / NEEDS_PRO 升级共用）：
// ⚠️ 2026-08-19 修正：千问不再作为 pro（它已是 flash 主力）——否则"升级"是假升级。
//   真 pro = ocGo deepseek-v4-pro（8/23 套餐恢复后）。（mimo-pro 已摘除）
// 2026-09-10：agnes-2.5-pro 首位摘除（cpk key 无 pro，每次先试再失败）；volces-ark 下架（用户定）
export function routeProCandidate() {
  // 用户定（2026-09-04）：Agnes 旗舰首选 pro；09-04 晚换 cpk 新 key（TokenPlan 套餐）后无 pro，
  // 降级到 agnes-2.5-flash 顶 pro 位（仍是 Agnes 优先），ocGo 套餐随后。
  // 2026-09-09：agnes-3.0-flash（思考型）发布，顶旗舰位，2.5-flash 退居其后
  return findLive("agnes", /3\.0-flash/i)
    || findLive("agnes", /2\.5-flash$/i)
    || ocGoCandidate(/deepseek-v4-pro/i);
}

// Auto 路由：按复杂度选 flash/pro。
// 显式配置了 CONFIG.model → 不用 Auto，直接用该默认模型；PI_AUTO_ROUTE=0 可关。
// ── 会话粘性路由（2026-08-24 补"来回甩锅"坑）──
// 坑：每条消息独立分类，同会话上一轮 complex 用了 pro、这一轮 simple 又甩回 flash——
// 上下文刚热就换模型，风格跳变 + prompt 缓存全失效。修复：simple 轮先查粘性窗口，
// 10 分钟内沿用上轮模型（只防降档不防升级：complex 轮照样升 pro）。
const stickyMap = new Map(); // sessionKey -> { key, until }
const STICKY_MS = 10 * 60 * 1000;
export function routeSticky(sessionKey) {
  if (!sessionKey) return null;
  const hit = stickyMap.get(sessionKey);
  if (!hit) return null;
  if (Date.now() > hit.until) { stickyMap.delete(sessionKey); return null; }
  const [provider, ...rest] = hit.key.split("/");
  const id = rest.join("/");
  const m = _getModelList().find(x => x.provider === provider && x.id === id);
  if (!m || isModelBlocked(m)) { stickyMap.delete(sessionKey); return null; }
  return m;
}
export function markSticky(sessionKey, m, ms = STICKY_MS) {
  if (!sessionKey || !m) return;
  stickyMap.set(sessionKey, { key: modelKey(m), until: Date.now() + ms });
  if (stickyMap.size > 500) { const now = Date.now(); for (const [k, v] of stickyMap) if (now > v.until) stickyMap.delete(k); }
}

export function routeForAuto(text, sessionKey) {
  if (_configModel) return { model: _getDefaultModel(), level: "simple", score: 0, reasons: ["显式默认模型"], auto: false };
  const cl = classifyTaskComplexity(text);
  if (process.env.PI_AUTO_ROUTE === "0") {
    return { model: _getDefaultModel(), level: "simple", score: 0, reasons: ["已关闭(PI_AUTO_ROUTE=0)"], auto: false };
  }
  if (cl.level === "complex") {
    const pro = routeProCandidate();
    if (pro) return { model: pro, level: "complex", score: cl.score, reasons: cl.reasons, auto: true };
    // 无可用 pro（ocGo 429 中、ark 不可用）→ 回落 flash 主力并播报真实原因，不假装升级
    const flash = flashCandidate();
    return { model: flash, level: "complex", score: cl.score, reasons: [...cl.reasons, "pro 暂不可用(ocGo 429)，回落主力模型"], auto: true };
  }
  // simple：粘性优先——10 分钟内沿用上轮模型，不降档不换人
  const sticky = routeSticky(sessionKey);
  if (sticky) return { model: sticky, level: "simple", score: cl.score, reasons: ["会话粘性(10min 内不降档)"], auto: true };
  return { model: flashCandidate(), level: cl.level, score: cl.score, reasons: cl.reasons, auto: true };
}
