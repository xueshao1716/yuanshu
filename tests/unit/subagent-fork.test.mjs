// fork 型子智能体测试：种子提取（只取已完成前缀）+ 深度闸门 + 真的注入到模型请求
// 运行：node --test tests/unit/subagent-fork.test.mjs
import { test, describe, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { forkSeedFromHistory } from "../../engine/subagent-fork.mjs";
import { nextSubagentDepth, DEFAULT_MAX_DEPTH } from "../../engine/subagent-depth.mjs";
import { initSubagent, spawnSubagent } from "../../engine/subagent.mjs";
import { execDelegateFork } from "../../engine/yuanshu-delegate.mjs";

const dirs = [];
async function tmp() { const d = await fs.mkdtemp(path.join(os.tmpdir(), "yuanshu-fork-")); dirs.push(d); return d; }
after(async () => { for (const d of dirs) { try { await fs.rm(d, { recursive: true, force: true }); } catch {} } });

/** 捕获发出去的 messages，用来断言种子真的进了请求。 */
async function setupWithCapture() {
  const dir = await tmp();
  const seen = [];
  initSubagent({
    httpFetch: async (_url, options = {}) => {
      try { seen.push(JSON.parse(String(options.body || "{}"))); } catch { seen.push(null); }
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ result: "结论", evidence: ["e1"], confidence: 0.9 }) } }] }), text: async () => "" };
    },
    authReader: () => ({ fake: { key: "k" } }),
    modelReader: () => ({ fake: { models: [{ id: "analysis-1", baseUrl: "https://fake.invalid" }] } }),
    resolveAuth: () => ({ baseUrl: "https://fake.invalid" }),
    getFlashModel: () => ({ provider: "fake", id: "analysis-1" }),
    traceDir: dir,
  });
  return { seen, dir };
}

describe("只取已完成的前缀（在飞的回合一律不要）", () => {
  test("空历史 → 没有可继承的东西", () => {
    assert.deepEqual(forkSeedFromHistory([]).messages, []);
    assert.deepEqual(forkSeedFromHistory(null).messages, []);
  });

  test("丢掉最后一条助手消息之后的全部内容（在飞回合）", () => {
    const h = [
      { role: "user", content: "先看看这个" },
      { role: "assistant", content: "看完了，结论是 A" },
      { role: "user", content: "接着查 B" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "巨大的工具输出" },
    ];
    const r = forkSeedFromHistory(h);
    assert.equal(r.messages.length, 2);
    assert.match(r.messages[1].content, /结论是 A/);
    assert.ok(!JSON.stringify(r.messages).includes("接着查 B"), "在飞的用户消息不该进种子");
    assert.ok(!JSON.stringify(r.messages).includes("巨大的工具输出"));
  });

  test("工具结果被丢弃，但必须自报（不能让子代理以为没发生过）", () => {
    const h = [
      { role: "user", content: "查一下" },
      { role: "tool", tool_call_id: "t1", content: "工具输出一" },
      { role: "assistant", content: "", tool_calls: [{ id: "t2", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t2", content: "工具输出二" },
      { role: "assistant", content: "查到了 X" }, // ← 前缀到此为止（最后一条有正文的助手消息）
      { role: "tool", tool_call_id: "t3", content: "在飞回合的工具输出，不该被计入" },
    ];
    const r = forkSeedFromHistory(h);
    assert.equal(r.droppedToolResults, 2, "只数前缀里的工具结果，在飞回合的不算");
    assert.match(r.messages[0].content, /2 条工具结果没有带过来/);
    assert.match(r.messages[0].content, /不要假设它没发生过/);
    assert.equal(r.truncated, true);
  });

  test("预算从最近往回取（子代理记得的是刚发生的事）", () => {
    const h = [];
    for (let i = 1; i <= 10; i++) { h.push({ role: "user", content: `问${i}` }); h.push({ role: "assistant", content: `答${i}` }); }
    const r = forkSeedFromHistory(h, { maxMessages: 4 });
    assert.equal(r.messages.length, 5, '4条前文加1条省略说明');
    assert.match(r.messages[r.messages.length - 1].content, /答10/);
    assert.match(r.messages[0].content, /省略/);
    assert.match(r.messages[1].content, /问9/);
    assert.equal(r.truncated, true);
  });

  test("单条过长会被截断，总字符预算也生效", () => {
    const h = [
      { role: "user", content: "短" },
      { role: "assistant", content: "长".repeat(3000) },
      { role: "user", content: "尾" },
      { role: "assistant", content: "终" },
    ];
    const r = forkSeedFromHistory(h, { perMessageChars: 100, maxChars: 150 });
    assert.ok(r.messages.every((m) => m.content.length <= 110), "单条应被截断");
    assert.ok(r.messages.reduce((n, m) => n + m.content.length, 0) <= 160, "总量应受控");
    assert.match(r.messages[r.messages.length - 1].content, /终/);
  });

  test("兼容内部 hist 形状（text 而不是 content）", () => {
    const h = [{ role: "user", text: "内部形状的问" }, { role: "assistant", text: "内部形状的答" }];
    const r = forkSeedFromHistory(h);
    assert.equal(r.messages.length, 2);
    assert.match(r.messages[1].content, /内部形状的答/);
  });
});

describe("深度闸门：只能加深，不能降低", () => {
  test("父 0 → 第 1 层，放行", () => {
    assert.deepEqual(nextSubagentDepth(0), { depth: 1, allowed: true });
  });

  test("超过上限直接不许派", () => {
    const r = nextSubagentDepth(DEFAULT_MAX_DEPTH, { maxDepth: DEFAULT_MAX_DEPTH });
    assert.equal(r.allowed, false);
    assert.equal(r.depth, DEFAULT_MAX_DEPTH + 1);
    assert.match(String(r.reason), /嵌套超过上限/);
  });

  test("运行期只能加深：传入更大的 runtimeDepth 以它为准（防从 0 重算绕过上限）", () => {
    // 若不取 max，父=0 的子代理会把深度算成 1，于是"最多 3 层"可以被反复绕过
    const r = nextSubagentDepth(0, { maxDepth: 3, runtimeDepth: 5 });
    assert.equal(r.depth, 5);
    assert.equal(r.allowed, false, "运行期声明得更深时必须更严，而不是被父深度拉回 1");
  });

  test("非法入参不炸，退回默认上限", () => {
    assert.equal(nextSubagentDepth(0, { maxDepth: NaN }).allowed, true);
    assert.equal(nextSubagentDepth(-5, { maxDepth: 0 }).depth, 1);
  });
});

describe("种子真的进模型请求，且顺序是 系统 → 种子 → 补充 → 子任务", () => {
  test("spawnSubagent 把 seed 放在上下文之前、任务之前", async () => {
    const { seen } = await setupWithCapture();
    const seed = [{ role: "user", content: "前文的问题" }, { role: "assistant", content: "前文的结论" }];
    const r = await spawnSubagent({ task: "接着核实", seed, context: ["额外事实"], sessionId: "s1", runId: "p1" });
    assert.equal(r.done, true);
    assert.equal(seen.length, 1);
    const msgs = seen[0].messages;
    const roles = msgs.map((m) => m.role);
    assert.equal(roles[0], "system");
    const iSeed = msgs.findIndex((m) => String(m.content).includes("前文的结论"));
    const iCtx = msgs.findIndex((m) => String(m.content).includes("额外事实"));
    const iTask = msgs.findIndex((m) => String(m.content).includes("接着核实"));
    assert.ok(iSeed > 0 && iSeed < iCtx && iCtx < iTask, `顺序不对：seed=${iSeed} ctx=${iCtx} task=${iTask}`);
  });

  test("超过深度上限时不派发（一次请求都不发）", async () => {
    const { seen } = await setupWithCapture();
    const r = await spawnSubagent({ task: "再派一层", parentDepth: DEFAULT_MAX_DEPTH, maxDepth: DEFAULT_MAX_DEPTH });
    assert.equal(r.done, false);
    assert.match(String(r.error), /嵌套超过上限/);
    assert.equal(seen.length, 0, "被闸门挡下就不该发出请求");
  });
});

describe("delegate_fork 工具", () => {
  test("没有可继承的前文时明确拒绝，并指回 delegate_task", async () => {
    const r = await execDelegateFork({ task: "看看" }, { history: [] });
    assert.equal(r.isError, true);
    assert.match(r.text, /没有可继承的前文/);
    assert.match(r.text, /delegate_task/);
  });

  test("缺 task 直接报错", async () => {
    const r = await execDelegateFork({}, {});
    assert.equal(r.isError, true);
    assert.match(r.text, /需要 task/);
  });

  test("有前文时继承，且回执自报漏掉了多少工具结果", async () => {
    await setupWithCapture();
    const history = [
      { role: "user", content: "帮我看看这个方案" },
      { role: "tool", tool_call_id: "t1", content: "工具输出" },
      { role: "assistant", content: "方案有两点问题" },
    ];
    const r = await execDelegateFork({ task: "把第二点展开" }, { history, sessionId: "s9", runId: "p9" });
    assert.equal(r.isError, false);
    assert.match(r.text, /继承前文；其中 1 条工具结果未带过去/);
    assert.match(r.text, /结论/);
  });
});
