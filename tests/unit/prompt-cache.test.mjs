// tests/unit/prompt-cache.test.mjs —— prompt cache 复用（优点一）
// 键 = sessionId + 模型 + 系统提示哈希；同会话同提示稳定命中，系统提示一变就换键。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { promptCacheDecision, leadingSystemPrompt } from "../../engine/unified-chat.mjs";

const SYS = [{ role: "system", content: "你是元枢。工具约束：……（约 2 万 token 的固定系统提示）" }];
const ask = (over = {}) => promptCacheDecision({
  provider: "openai",
  modelId: "gpt-5.6-luna",
  api: "openai-responses",
  compat: { supportsExplicitPromptCacheMode: true },
  messages: [...SYS, { role: "user", content: "继续" }],
  sessionId: "session-abc",
  mode: "auto",
  ...over,
});

test("同输入同键：同一会话、同一系统提示反复调用键不变", () => {
  const a = ask(), b = ask();
  assert.equal(a.key, b.key);
  assert.match(a.key, /^[0-9a-f]{32}$/);
  assert.equal(a.sent, true);
  assert.equal(a.reason, "provider-supports-cache");
});

test("系统提示变了 → 键一定换（不拿旧缓存充数）", () => {
  const a = ask({ messages: [...SYS, { role: "user", content: "继续" }] });
  const b = ask({ messages: [{ role: "system", content: "你是元枢（人格刚刚换过）。" }] });
  assert.notEqual(a.key, b.key);
});

test("会话或模型变了也换键；中途插入的 system 插话不算系统提示", () => {
  assert.notEqual(ask().key, ask({ sessionId: "session-xyz" }).key);
  assert.notEqual(ask().key, ask({ modelId: "gpt-6-sol" }).key);
  const steered = [
    ...SYS,
    { role: "user", content: "继续" },
    { role: "system", content: "【伙伴中途插话】换个做法" },
  ];
  assert.equal(leadingSystemPrompt(steered), leadingSystemPrompt(SYS));
  assert.equal(ask({ messages: steered }).key, ask().key);
});

test("mode:disabled → 一律不发", () => {
  const d = ask({ mode: "disabled" });
  assert.equal(d.sent, false);
  assert.equal(d.reason, "mode-disabled");
  assert.ok(d.key, "键照算，日志里能核对");
});

test("未知 provider 默认不发（避免网关 400）；compat 声明或官方端点才发", () => {
  const unknown = ask({ provider: "some-relay", modelId: "glm-5.3-flash", api: "openai-completions", compat: {} });
  assert.equal(unknown.sent, false);
  assert.equal(unknown.reason, "unknown-provider");
  assert.equal(ask({ provider: "some-relay", compat: {}, baseUrl: "https://api.openai.com/v1" }).sent, true);
  assert.equal(ask({ provider: "relay-azure", compat: {}, baseUrl: "https://x.openai.azure.com" }).sent, true);
});

test("mode:enabled 强制发；Anthropic 原生仍然不发（它走 cache_control）", () => {
  const forced = ask({ provider: "some-relay", compat: {}, mode: "enabled" });
  assert.equal(forced.sent, true);
  const native = ask({ provider: "anthropic", modelId: "claude-fable", api: "anthropic-messages", compat: {}, mode: "enabled" });
  assert.equal(native.sent, false);
  assert.equal(native.reason, "anthropic-native");
});

test("静态断言：请求体确实带上了字段，且每轮打一行 [cache]", () => {
  const src = fs.readFileSync(new URL("../../engine/unified-chat.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(promptCache\.sent\) body\.prompt_cache_key = promptCache\.key;/);
  assert.match(src, /\[cache\] key=\$\{String\(decision\?\.key \|\| ""\)\.slice\(0, 8\)\} sent=/);
});

test("注入断言：真实请求体里带稳定的 prompt_cache_key，未知通道不带", async (t) => {
  const http = await import("node:http");
  const os = await import("node:os");
  const { initUnifiedChat, unifiedChat } = await import("../../engine/unified-chat.mjs");
  const { initDshKeys } = await import("../../engine/dsh-keys.mjs");
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ message: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const cached = { provider: "cache-on", id: "mock-a", api: "openai-responses", baseUrl, compat: { supportsExplicitPromptCacheMode: true } };
  const unknown = { provider: "cache-off", id: "mock-b", api: "openai-completions", baseUrl, compat: {} };
  const store = { "cache-on": { models: [cached] }, "cache-off": { models: [unknown] } };
  const readJsonFile = (file) => (file === "auth" ? { "cache-on": { key: "k" }, "cache-off": { key: "k" } } : store);
  initDshKeys({ authPath: "auth", modelsPath: "models", readJsonFile });
  // cwd 指到临时目录：不读开发机上的 缓存.json，mode 一定是默认 auto
  initUnifiedChat({ authPath: "auth", modelsPath: "models", readJsonFile, getModelList: () => [cached, unknown], cwd: os.tmpdir(), UNIFIED_TOOLS: [] });
  const messages = [{ role: "system", content: "你是元枢" }, { role: "user", content: "在吗" }];

  await unifiedChat(cached, messages, { tools: false, sessionId: "s1" });
  await unifiedChat(cached, messages, { tools: false, sessionId: "s1" });
  await unifiedChat(cached, messages, { tools: false, sessionId: "s2" });
  await unifiedChat(unknown, messages, { tools: false, sessionId: "s1" });

  assert.match(bodies[0].prompt_cache_key, /^[0-9a-f]{32}$/);
  assert.equal(bodies[1].prompt_cache_key, bodies[0].prompt_cache_key, "同会话同提示必须复用同一个键");
  assert.notEqual(bodies[2].prompt_cache_key, bodies[0].prompt_cache_key, "换会话要换键");
  assert.equal(bodies[3].prompt_cache_key, undefined, "未知通道默认不发，免得网关 400");
});

