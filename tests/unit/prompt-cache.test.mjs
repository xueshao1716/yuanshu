// tests/unit/prompt-cache.test.mjs —— prompt cache 复用（优点一）
// 键 = sessionId + 模型 + 系统提示哈希；同会话同提示稳定命中，系统提示一变就换键。
// 2026-11-13：时间/间隔从 system 搬到本轮 user 末尾——它每轮都变，是键每轮都换的主因。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { promptCacheDecision, leadingSystemPrompt } from "../../engine/unified-chat.mjs";
import { assembleYuanshuSystem } from "../../engine/yuanshu-seams.mjs";
import { prependAssembledSystem, timeInUserEnabled } from "../../engine/yuanshu-prompt.mjs";

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

// ══ 时间/间隔搬出 system（2026-11-13）════════════════════════════════════════
// 旧行为：system 里带「当前时间：…（周X）」+「距上次对话 N 分钟」→ 同一会话隔一分钟就是
// 两个不同的前导 system：prompt_cache_key 每轮换一个、服务端前缀缓存在变动处之后全作废。
// 新行为：system 只留稳定区段，时间贴到**最后一轮 user 消息末尾**（模型照样拿得到）。
const T0 = new Date(2026, 10, 13, 21, 40);   // 2026-11-13 是周五

function tempWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "yuanshu-cache-"));
  // 先把「记忆」建出来：否则第一次调用才创建它，第二次就会从「生活」变成「活了 1 天」，
  // 那是自我模型的天数探测，与时间无关，但会让"逐字节相同"的断言假失败。
  fs.mkdirSync(path.join(dir, "记忆"), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

/** 造一轮真实形态的 system + 历史（时间上下文由接缝生成，不是手写字符串）。 */
function buildTurn(wsRoot, now) {
  const sections = assembleYuanshuSystem(
    {
      message: "继续",
      persona: "你是小语。",
      rules: "别乱改文件",
      tools: "工具说明",
      runtime: "runtime 事实",
    },
    null,
    {
      wsRoot,
      now,
      since: T0.getTime() - 3 * 60000,
      sessionStart: T0.getTime() - 30 * 60000,
      model: { provider: "deepseek", id: "v4-flash" },
      sessionId: "session-cache-1",
      message: "继续",
    },
  );
  const history = prependAssembledSystem([{ role: "user", content: "继续" }], sections);
  return {
    sections,
    history,
    system: history[0].content,
    lastUser: history[history.length - 1].content,
  };
}

test("时间搬出 system：相隔 1 分钟的两轮，system 逐字节相同（哈希也相同）", (t) => {
  const wsRoot = tempWorkspace(t);
  const a = buildTurn(wsRoot, T0);
  const b = buildTurn(wsRoot, new Date(T0.getTime() + 60_000));
  const sha = (s) => createHash("sha256").update(s).digest("hex");

  assert.equal(a.system, b.system, "同一会话、同一人格，两轮 system 必须逐字节相同");
  assert.equal(sha(a.system), sha(b.system));
  assert.ok(!a.system.includes("当前时间"), "system 里不该再有当前时间");
  assert.ok(!a.system.includes("### section:time"), "time 段不该再拼进 system");
  // 时间只是换了位置：sections.time 仍在（预览/评测/回退档看到的一致）
  assert.match(String(a.sections.time), /当前时间：2026-11-13 21:40/);
});

test("时间不再掺进键：相隔 1 分钟两轮的 prompt_cache_key 是同一个", (t) => {
  const wsRoot = tempWorkspace(t);
  const decide = (turn) => promptCacheDecision({
    provider: "openai",
    modelId: "gpt-5.6-luna",
    api: "openai-responses",
    compat: { supportsExplicitPromptCacheMode: true },
    messages: turn.history,
    sessionId: "session-cache-1",
    mode: "auto",
  });
  const a = decide(buildTurn(wsRoot, T0));
  const b = decide(buildTurn(wsRoot, new Date(T0.getTime() + 60_000)));
  assert.equal(a.sent, true);
  assert.equal(b.key, a.key, "时间进 user 后，两轮键必须一致");
  assert.match(a.key, /^[0-9a-f]{32}$/);
});

test("模型仍拿得到时间：文案贴在本轮 user 末尾；YUANSHU_TIME_IN_USER=0 回到 system 原位", (t) => {
  const wsRoot = tempWorkspace(t);
  const on = buildTurn(wsRoot, T0);
  assert.match(
    on.lastUser,
    /【当前时间 2026-11-13 21:40（周五） · 距上次对话 3 分钟 · 本次会话已持续 30 分钟】$/,
    "时间必须出现在最后一条 user 消息的末尾",
  );

  // 静态断言：开关在 prompt.mjs 里按调用时读环境变量，只有显式 "0" 才回退
  const src = fs.readFileSync(new URL("../../engine/yuanshu-prompt.mjs", import.meta.url), "utf8");
  assert.match(src, /YUANSHU_TIME_IN_USER/);
  assert.match(src, /String\(env\?\.YUANSHU_TIME_IN_USER \?\? ""\)\.trim\(\) !== "0"/);

  // 回退档：时间留在 system 原位置，user 末尾不再追加
  const prev = process.env.YUANSHU_TIME_IN_USER;
  process.env.YUANSHU_TIME_IN_USER = "0";
  t.after(() => {
    if (prev === undefined) delete process.env.YUANSHU_TIME_IN_USER;
    else process.env.YUANSHU_TIME_IN_USER = prev;
  });
  assert.equal(timeInUserEnabled(), false);
  const off = buildTurn(wsRoot, T0);
  assert.ok(off.system.includes("### section:time"), "回退档 time 段要回到 system");
  assert.match(off.system, /当前时间：2026-11-13 21:40/);
  assert.equal(off.lastUser, "继续", "回退档不该再往 user 末尾贴时间");
});

