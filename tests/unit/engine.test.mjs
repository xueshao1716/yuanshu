// ===== engine.test.mjs —— Gateway 2.0 引擎 + CodeRuntime 单元测试 =====
import { test } from "node:test";
import assert from "node:assert/strict";

import { PluginRegistry } from "../../engine/plugin-registry.mjs";
import { ToolRegistry } from "../../engine/tool-registry.mjs";
import { MemorySessionStore, FileSessionStore } from "../../engine/session-store.mjs";
import { HttpModelAdapter } from "../../engine/model/adapter.mjs";
import { StandardAgentLoop } from "../../engine/agent-loop.mjs";
import { CodeRuntime } from "../../code-mode/code-runtime.mjs";

// ── PluginRegistry ──
test("PluginRegistry: 注册/依赖/卸载", async () => {
  const reg = new PluginRegistry();
  const order = [];
  reg.register({ id: "a", deps: [], mount: () => { order.push("mount-a"); return { v: 1 }; } });
  reg.register({ id: "b", deps: ["a"], mount: () => { order.push("mount-b"); return { v: 2 }; } });
  await reg.mountAll();
  assert.deepEqual(order, ["mount-a", "mount-b"], "依赖先挂载");
  assert.equal(reg.get("a").v, 1);
  assert.equal(reg.get("b").v, 2);
  assert.equal(reg.list().length, 2);
  // 卸载 b（依赖 a 的）后 a 才能卸
  await reg.unregister("a");
  assert.equal(reg.has("a"), false);
  assert.equal(reg.has("b"), false, "依赖者随被依赖者一起卸载");
});

test("PluginRegistry: 缺依赖报错", () => {
  const reg = new PluginRegistry();
  assert.throws(() => reg.register({ id: "x", deps: ["none"], mount: () => ({}) }), /依赖/);
});

// ── ToolRegistry ──
test("ToolRegistry: 注册/执行/回退默认执行器", async () => {
  const tr = new ToolRegistry();
  tr.register({ name: "add", description: "加法", handler: ({ a, b }) => ({ text: String(a + b) }) });
  assert.equal(tr.has("add"), true);
  const out = await tr.execute("add", { a: 1, b: 2 });
  assert.equal(out.text, "3");
  // 未知工具 → 默认执行器
  const tr2 = new ToolRegistry({ defaultExecutor: async (name) => ({ text: `default:${name}` }) });
  const o2 = await tr2.execute("anything", {});
  assert.equal(o2.text, "default:anything");
  // 注册冲突报错
  assert.throws(() => tr.register({ name: "add", handler: () => ({}) }), /已注册/);
});

// ── SessionStore ──
test("MemorySessionStore: save/load/list/delete", async () => {
  const s = new MemorySessionStore();
  await s.save({ id: "s1", title: "测试", history: [{ role: "user", content: "hi" }], updatedAt: 1 });
  const loaded = await s.load("s1");
  assert.equal(loaded.title, "测试");
  assert.equal((await s.list()).length, 1);
  await s.delete("s1");
  assert.equal(await s.load("s1"), null);
});

// ── HttpModelAdapter（mock httpFetch，验证工具轮次 + 思考提取）──
// 注意：adapter 只负责单次模型请求；工具循环在 AgentLoop 层。
test("HttpModelAdapter: 单次请求返回 toolCalls / 思考提取", async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const body = calls.length === 1
      ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{\"command\":\"dir\"}" } }] } }] }
      : { choices: [{ message: { role: "assistant", content: "<think>想了一下</think>最终答案" } }] };
    return { status: 200, ok: true, json: async () => body, text: async () => "" };
  };
  const adapter = new HttpModelAdapter({ httpFetch: fakeFetch, authReader: () => ({ deepseek: { key: "k" } }), modelReader: () => ({}), resolveAuth: () => ({ baseUrl: "https://api.deepseek.com/v1" }) });
  const msgs = [{ role: "user", content: "hi" }];
  // 第一轮：模型要调工具
  const r1 = await adapter.chat({ id: "deepseek-chat", provider: "deepseek" }, msgs, { tools: [{ type: "function", function: { name: "bash" } }] });
  assert.equal(r1.toolCalls.length, 1);
  assert.equal(r1.toolCalls[0].function.name, "bash");
  // 第二轮（loop 执行完工具后再次调用）：思考提取
  const r2 = await adapter.chat({ id: "deepseek-chat", provider: "deepseek" }, r1.history, { tools: [{ type: "function", function: { name: "bash" } }] });
  assert.equal(r2.think, "想了一下");
  assert.equal(r2.text, "最终答案");
  assert.equal(calls.length, 2, "两轮独立请求");
});

// ── StandardAgentLoop（mock adapter，验证工具执行 + 防循环）──
test("StandardAgentLoop: 工具循环执行", async () => {
  let toolCalls = 0;
  const mockAdapter = {
    async chat() {
      if (toolCalls === 0) {
        return { toolCalls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }], history: [] };
      }
      return { text: "完成", history: [] };
    },
  };
  const tools = new ToolRegistry();
  tools.register({ name: "bash", handler: () => { toolCalls++; return { text: "ok" }; } });
  const loop = new StandardAgentLoop();
  const r = await loop.run({ message: "干活", model: { id: "m", provider: "p" }, tools, opts: { modelAdapter: mockAdapter } });
  assert.equal(r.text, "完成");
  assert.equal(toolCalls, 1);
});

test("StandardAgentLoop: 相同工具调用 3 次中断（防死循环）", async () => {
  const mockAdapter = {
    async chat() {
      return { toolCalls: [{ id: "c" + Math.random(), function: { name: "loop", arguments: "{}" } }], history: [] };
    },
  };
  const tools = new ToolRegistry();
  tools.register({ name: "loop", handler: () => ({ text: "again" }) });
  const loop = new StandardAgentLoop();
  const r = await loop.run({ message: "go", model: { id: "m", provider: "p" }, tools, opts: { modelAdapter: mockAdapter } });
  assert.match(r.error || "", /循环/);
});

// ── CodeRuntime（真实执行：worker_threads）──
test("CodeRuntime: 执行程序 + 绑定调用 + 日志 + 返回值", async () => {
  const runtime = new CodeRuntime({
    bindings: {
      double: { description: "翻倍", args: "n", exec: async ([n]) => ({ text: String(n * 2) }) },
    },
  });
  const r = await runtime.run({
    program: `
      console.log("开始");
      const a = await $tools.double(21);
      console.log("翻倍结果:", a.text);
      return "最终值=" + a.text;
    `,
  });
  assert.equal(r.error, undefined);
  assert.equal(r.value, "最终值=42");
  assert.ok(r.logs.some((l) => l.includes("开始")), "日志包含 console.log");
});

test("CodeRuntime: 超时终止", async () => {
  const runtime = new CodeRuntime({
    bindings: {
      slow: { description: "慢", exec: async () => { await new Promise((r) => setTimeout(r, 5000)); return { text: "done" }; } },
    },
  });
  const r = await runtime.run({ program: `await $tools.slow(); return 1;`, timeoutMs: 500 });
  assert.equal(r.error.kind, "timeout");
});

test("CodeRuntime: 运行时错误分类", async () => {
  const runtime = new CodeRuntime({ bindings: {} });
  const r = await runtime.run({ program: `throw new Error("炸了");` });
  assert.equal(r.error.kind, "runtime");
  assert.match(r.error.message, /炸了/);
});

test("CodeRuntime: 解析错误", async () => {
  const runtime = new CodeRuntime({ bindings: {} });
  const r = await runtime.run({ program: `const = broken syntax` });
  assert.equal(r.error.kind, "runtime", "语法错误在 new Function 阶段抛出，归类 runtime");
  assert.ok(r.error.message);
});
