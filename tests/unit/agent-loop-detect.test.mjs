// StandardAgentLoop 防死循环判定：按“连续相同调用”计数 + 第 2 次软提醒，第 3 次才中断。
// 旧版按累计计数，会把“交叉读同一文件 / 无参工具反复调用”误判为循环。
import test from "node:test";
import assert from "node:assert/strict";
import { StandardAgentLoop } from "../../engine/agent-loop.mjs";

const tc = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });

function makeTools() {
  const calls = [];
  return {
    calls,
    list() { return [{ name: "read" }, { name: "todo_read" }, { name: "fail_tool" }]; },
    getDef(name) { return { name }; },
    async execute(name, args) {
      calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
      if (name === "fail_tool") return { text: "boom", isError: true };
      return { text: `ok:${name}:${JSON.stringify(args)}` };
    },
  };
}

function makeAdapter(script) {
  let i = 0;
  return {
    async chat(model, messages) {
      const step = script[i++] || { text: "（脚本耗尽）" };
      if (step.toolCalls) {
        return { toolCalls: step.toolCalls, history: [...messages, { role: "assistant", content: null, tool_calls: step.toolCalls }] };
      }
      return { text: step.text || "done" };
    },
  };
}

async function run(script) {
  const tools = makeTools();
  const loop = new StandardAgentLoop({ maxTurns: 20 });
  const r = await loop.run({ message: "测试", history: [], model: { id: "test-model" }, tools, opts: { modelAdapter: makeAdapter(script) } });
  const texts = (r.history || []).filter((m) => m.role === "tool").map((m) => String(m.content || ""));
  return { r, tools, texts };
}

test("交叉读同一文件 3 次不算循环", async () => {
  const { r, tools } = await run([
    { toolCalls: [tc("1", "read", { path: "a.md" })] },
    { toolCalls: [tc("2", "read", { path: "b.md" })] },
    { toolCalls: [tc("3", "read", { path: "a.md" })] },
    { toolCalls: [tc("4", "read", { path: "b.md" })] },
    { toolCalls: [tc("5", "read", { path: "a.md" })] },
    { text: "完成" },
  ]);
  assert.equal(r.error, undefined);
  assert.equal(r.text, "完成");
  assert.equal(tools.calls.length, 5);
});

test("真连续 3 次相同调用：第 3 次中断，报错带工具名与次数", async () => {
  const { r, tools } = await run([
    { toolCalls: [tc("1", "read", { path: "a.md" })] },
    { toolCalls: [tc("2", "read", { path: "a.md" })] },
    { toolCalls: [tc("3", "read", { path: "a.md" })] },
    { toolCalls: [tc("4", "read", { path: "a.md" })] },
  ]);
  assert.match(r.error, /read/);
  assert.match(r.error, /3 次/);
  assert.equal(tools.calls.length, 3);
});

test("连续第 2 次收到软提醒、保留原结果，改道后正常完成", async () => {
  const { r, texts } = await run([
    { toolCalls: [tc("1", "read", { path: "a.md" })] },
    { toolCalls: [tc("2", "read", { path: "a.md" })] },
    { toolCalls: [tc("3", "read", { path: "b.md" })] },
    { text: "完成" },
  ]);
  assert.ok(texts.some((t) => t.includes("这已是你连续第 2 次") && t.includes("ok:read")));
  assert.equal(r.error, undefined);
  assert.equal(r.text, "完成");
});

test("无参工具交叉出现 3 次不算循环", async () => {
  const { r, tools } = await run([
    { toolCalls: [tc("1", "todo_read", {})] },
    { toolCalls: [tc("2", "read", { path: "a.md" })] },
    { toolCalls: [tc("3", "todo_read", {})] },
    { toolCalls: [tc("4", "read", { path: "b.md" })] },
    { toolCalls: [tc("5", "todo_read", {})] },
    { text: "完成" },
  ]);
  assert.equal(r.error, undefined);
  assert.equal(tools.calls.length, 5);
});

test("连续失败 5 次给换路提醒，但不中断", async () => {
  const fail = (id) => ({ toolCalls: [tc(id, "fail_tool", { x: 1 })] });
  const { r, texts } = await run([fail("1"), fail("2"), fail("3"), fail("4"), fail("5"), { text: "放弃该工具" }]);
  assert.ok(texts.some((t) => t.includes("已连续失败 5 次")));
  assert.equal(r.error, undefined);
  assert.equal(r.text, "放弃该工具");
});

test("失败与成功交替时失败计数重置", async () => {
  const { r, texts } = await run([
    { toolCalls: [tc("1", "fail_tool", { x: 1 })] },
    { toolCalls: [tc("2", "read", { path: "a.md" })] },
    { toolCalls: [tc("3", "fail_tool", { x: 1 })] },
    { toolCalls: [tc("4", "read", { path: "b.md" })] },
    { toolCalls: [tc("5", "fail_tool", { x: 1 })] },
    { text: "完成" },
  ]);
  assert.ok(!texts.some((t) => t.includes("已连续失败")));
  assert.equal(r.error, undefined);
  assert.equal(r.text, "完成");
});

test("同批次并行重复也计入连续次数", async () => {
  const { r, tools } = await run([
    { toolCalls: [tc("1", "read", { path: "a.md" }), tc("2", "read", { path: "a.md" })] },
    { toolCalls: [tc("3", "read", { path: "a.md" })] },
    { text: "完成" },
  ]);
  assert.ok(r.error);
  assert.equal(tools.calls.length, 3);
});
