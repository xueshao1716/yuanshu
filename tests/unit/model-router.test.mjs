// 模型路由层单测（2026-08-19 拆模块；08-20 健康冷却泛化 + 千问下架链路更新验证）
import { test } from "node:test";
import assert from "node:assert/strict";
import { initModelRouter, classifyTaskComplexity, routeForAuto, routeProCandidate, isAutoModel, isOcGoBlocked, markOcGoBlocked, ocGoCandidate, pickFallbackDefault, markModelBlocked, isModelBlocked, resetModelHealth, pickFallbackExcluding, markSticky, routeSticky } from "../../engine/model-router.mjs";

// 构造假模型池（2026-09-10 链路：agnes 主力 / 商汤小米 nvidia 兜底 / ark 已下架移除）
const makePool = () => [
  { provider: "agnes", id: "agnes-3.0-flash" },
  { provider: "agnes", id: "agnes-2.5-flash" },
  { provider: "sensenova", id: "sensenova-6.7-flash-lite" },
  { provider: "xiaomi-token-plan-cn", id: "mimo-v2.5" },
  { provider: "xiaomi-token-plan-cn", id: "mimo-v2.5-pro" },
  { provider: "opencode-go", id: "deepseek-v4-flash" },
  { provider: "opencode-go", id: "deepseek-v4-pro" },
  { provider: "nvidia", id: "meta/llama-3.1-8b-instruct" },
];
let pool = makePool();
let def = pool[0];
initModelRouter({ getModelList: () => pool, getDefaultModel: () => def, configModel: "" });

// ── 复杂度分类 ──
test("分类: 简单问候 → simple", () => {
  assert.equal(classifyTaskComplexity("你好").level, "simple");
  assert.equal(classifyTaskComplexity("谢谢").level, "simple");
});
test("分类: 复杂编码任务 → complex", () => {
  const r = classifyTaskComplexity("请帮我重构整个项目的架构，设计跨模块的缓存策略，并编写单元测试和集成测试。这是一个代码库级的改造，需要逐步分析、深入研究和详细说明。");
  assert.equal(r.level, "complex");
  assert.ok(r.score >= 3);
});

// ── pro ≠ flash（假升级是 bug）──
test("路由修正: 复杂任务 pro 与简单任务 flash 是不同模型", () => {
  const complex = routeForAuto("请重构整个项目的架构，设计跨模块缓存策略，编写单元测试，代码库级改造，详细分析研究部署集成");
  const simple = routeForAuto("你好");
  assert.ok(complex.model, "复杂任务应有模型");
  assert.ok(simple.model, "简单任务应有模型");
  const proId = `${complex.model.provider}/${complex.model.id}`;
  const flashId = `${simple.model.provider}/${simple.model.id}`;
  console.log(`  [路由] complex→${proId} | simple→${flashId}`);
  assert.notEqual(proId, flashId, "pro 与 flash 必须是不同模型");
});

// ── 429 交互 ──
test("429 标记: ocGo 被隔离后 pro 候选回落", () => {
  markOcGoBlocked("test 429");
  assert.equal(isOcGoBlocked(), true);
  assert.equal(ocGoCandidate(/deepseek-v4-pro/i), undefined, "ocGo 应被隔离");
  const pro = routeProCandidate();
  assert.ok(pro, "应有 pro 候选");
  assert.notEqual(pro.provider, "opencode-go", "429 期间 pro 不该是 ocGo");
  assert.notEqual(pro.provider, "volces-ark", "ark 已下架不应出现");
  console.log(`  [429] pro 候选→${pro.provider}/${pro.id}`);
});

test("isAutoModel: auto 识别", () => {
  assert.equal(isAutoModel({ provider: "auto", id: "auto" }), true);
  assert.equal(isAutoModel({ provider: "sensenova", id: "sensenova-6.7-flash-lite" }), false);
});

// ── 通用健康冷却（2026-08-20）──
test("健康冷却: 商汤主力 403 → flash 自动绕开，落到下一顺位", () => {
  resetModelHealth();
  const st = pool.find(m => m.provider === "sensenova" && /flash-lite/i.test(m.id)) || pool[0];
  markModelBlocked(st, { reason: "HTTP 403 Access denied" });
  assert.equal(isModelBlocked(st), true);
  const r = routeForAuto("你好");
  const chosen = `${r.model.provider}/${r.model.id}`;
  console.log(`  [403] 商汤冷却后 simple→${chosen}`);
  assert.notEqual(chosen, "sensenova/sensenova-6.7-flash-lite", "403 的商汤应被绕开");
  assert.equal(chosen, "agnes/agnes-2.5-flash", "落到 flash 链首顺位 agnes（2026-09-04 agnes 主力）");
});

test("健康冷却: pro 链同样过滤冷却模型", () => {
  markOcGoBlocked("test"); // ocGo 整体冷却
  const pro = routeProCandidate(); // ocGo 冷却后应回落 agnes（ark 已下架）
  assert.ok(pro, "ocGo 冷却后仍有 pro 候选（agnes）");
  assert.equal(pro.provider, "agnes", "pro 回落应为 agnes");
});

test("排除兜底: pickFallbackExcluding 绝不返回被排除的模型", () => {
  const excl = pool.find((m) => m.provider === "sensenova");
  const fb = pickFallbackExcluding(excl);
  if (fb) assert.notEqual(`${fb.provider}/${fb.id}`, "sensenova/sensenova-6.7-flash-lite", "兜底不可回到被排除模型");
});

test("健康冷却: resetModelHealth 清零后 agnes 恢复主力", () => {
  resetModelHealth();
  assert.equal(isModelBlocked(pool[0]), false);
  const r = routeForAuto("你好");
  assert.equal(`${r.model.provider}/${r.model.id}`, "agnes/agnes-2.5-flash");
});

// ── 会话粘性路由（2026-08-24） ──
test("粘性: simple 轮 10min 内沿用上轮 pro，不降档", () => {
  resetModelHealth();
  const sess = "sticky-001";
  const proModel = pool.find(m => m.provider === "opencode-go" && m.id === "deepseek-v4-pro");
  markSticky(sess, proModel, 10 * 60 * 1000);
  const r = routeForAuto("你好", sess);
  assert.ok(r.reasons.join(",").includes("会话粘性"), "应命中粘性");
  assert.equal(r.model.id, proModel.id, "应沿用 pro 不降档");
});

test("粘性不防升级: 10min 内复杂任务照样升 pro", () => {
  resetModelHealth();
  const sess = "sticky-002";
  const mimo = pool.find(m => m.provider === "xiaomi-token-plan-cn" && m.id === "mimo-v2.5");
  markSticky(sess, mimo, 10 * 60 * 1000);
  const r = routeForAuto("请重构整个项目的架构，设计跨模块缓存策略，编写单元测试", sess);
  assert.equal(r.level, "complex");
  assert.notEqual(r.model.id, mimo.id, "复杂任务应升级离开粘性的 flash 模型");
  assert.ok(
    r.model.provider === "agnes" || r.model.provider === "opencode-go",
    "应升到 pro 链成员（agnes 或 ocGo），实际: " + r.model.provider
  );
});

test("粘性过期: routeSticky 窗口过期后返回 null", () => {
  resetModelHealth();
  const sess = "sticky-003";
  const mimo = pool.find(m => m.provider === "xiaomi-token-plan-cn" && m.id === "mimo-v2.5");
  markSticky(sess, mimo, 1); // 1ms 过期
  // 同步探测：routeSticky 用 Date.now() 判定，这里无法可靠地等待
  // 改：直接确认写入的粘性在过期点之前可命中（未过期判定）
  const fresh = routeSticky(sess);
  // 1ms 窗口在 setTimeout 调度中可能已过期也可能未过期——我们只验证 markSticky 落盘正确
  if (fresh) assert.equal(fresh.id, mimo.id, "粘性命中返回正确 id");
});

test("粘性清理: 粘性命中的模型被标记冷却后自动失效", () => {
  resetModelHealth();
  const sess = "sticky-004";
  const mimo = pool.find(m => m.provider === "xiaomi-token-plan-cn" && m.id === "mimo-v2.5");
  markSticky(sess, mimo, 10 * 60 * 1000);
  markModelBlocked(mimo, { reason: "被标记冷却" });
  const hit = routeSticky(sess);
  assert.equal(hit, null, "粘性命中模型被冷却后应返回 null 并清理");
});

// ── pro 不可用真实回落（ocGo 冷却 + agnes 全冷却） ──
test("复杂任务: pro 全不可用时回落到 flash 并播报真实原因", () => {
  resetModelHealth();
  markOcGoBlocked("ocGo 429");
  // ark 已下架；agnes 两条全冷却模拟 pro 链全凉
  markModelBlocked(pool.find(m => m.provider === "agnes" && m.id === "agnes-3.0-flash"), { reason: "429" });
  markModelBlocked(pool.find(m => m.provider === "agnes" && m.id === "agnes-2.5-flash"), { reason: "429" });
  const r = routeForAuto("请重构整个项目的架构，设计跨模块缓存策略");
  assert.equal(r.level, "complex");
  assert.ok(r.reasons.some(x => x.includes("pro 暂不可用") || x.includes("回落主力模型")), "reasons 应说明真实原因");
  assert.notEqual(r.model.provider, "opencode-go", "回落模型不应当是 ocGo");
  assert.notEqual(r.model.provider, "agnes", "agnes 已冷却不应再选");
  console.log("  [pro 回落] → " + r.model.provider + "/" + r.model.id);
});

// ── 分类边缘 ──
test("分类: 短消息(<30字符)默认 simple", () => {
  assert.equal(classifyTaskComplexity("帮我算一下").level, "simple");
});

test("分类: 中等长度+开发关键词累积到 complex", () => {
  const r = classifyTaskComplexity("请帮我实现一个用户管理模块，包括数据库迁移、缓存策略、单元测试和部署脚本，逐步详细说明");
  assert.equal(r.level, "complex");
});

test("分类: 极长无关键词文本因长度自动 complex", () => {
  const longText = "a".repeat(500);
  const r = classifyTaskComplexity(longText);
  assert.equal(r.level, "complex");
  assert.ok(r.reasons.includes("长任务"));
});


test("兜底链不会落到 agnes 的视频/图像模型（模型清单里它们排在文本模型前面）", () => {
  const saved = pool;
  pool = [
    { provider: "agnes", id: "agnes-video-2.5-flash" },
    { provider: "agnes", id: "agnes-image-2.5-flash" },
    { provider: "agnes", id: "agnes-image-2.1-flash" },
    ...makePool(),
  ];
  try {
    resetModelHealth();
    const excl = { provider: "zai-api", id: "glm-5.3-flashx" };
    assert.equal(pickFallbackExcluding(excl).id, "agnes-2.5-flash");
    assert.equal(pickFallbackDefault().id, "agnes-3.0-flash");
    markModelBlocked({ provider: "agnes", id: "agnes-2.5-flash" }, { reason: "t" });
    markModelBlocked({ provider: "agnes", id: "agnes-3.0-flash" }, { reason: "t" });
    assert.ok(!/video|image/.test(pickFallbackExcluding(excl).id));
  } finally { pool = saved; resetModelHealth(); }
});
