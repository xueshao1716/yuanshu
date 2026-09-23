// 元枢主循环：工具轮走调度器（abort/并行），run_code 进 UNIFIED_TOOLS
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ABORTED_MARKER } from "../../engine/tool-scheduler.mjs";
import {
  toolCallLoopKey,
  runYuanshuToolRound,
  toolCallsFromPlan,
  attachYuanshuCodeTool,
} from "../../engine/yuanshu-loop.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tc(name, args = {}, id = name) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

test("toolCallLoopKey：不同 SVG 文件和内容不能合并为同一调用", () => {
  const a = toolCallLoopKey("write", { path: "a.svg", content: "<svg><rect/></svg>" });
  const b = toolCallLoopKey("write", { path: "b.svg", content: "<svg><circle/></svg>" });
  assert.notEqual(a, b);
  assert.notEqual(a, toolCallLoopKey("write", { path: "a.svg", content: "<svg><circle/></svg>" }));
});

test("含 SVG 的网页分块追加可完成收尾，保留全部工具结果和检查点", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yuanshu-svg-chunks-"));
  const path = join(dir, "website.html");
  const chunks = ["<!doctype html><html><body>", ...Array.from({ length: 5 }, (_, i) =>
    `<section id="part-${i}"><svg><text>${i}</text></svg>${"x".repeat(6000)}</section>`), "</body></html>"];
  const history = [], stuckEvents = [], seenCalls = new Map();
  try {
    for (let i = 0; i < chunks.length; i++) {
      const args = { path, content: chunks[i], append: i > 0 };
      const result = await runYuanshuToolRound({
        toolCalls: [tc("write", args, `chunk-${i}`)], history, stuckEvents, seenCalls,
        sandboxWsRoot: dir,
        execute: async (_name, a) => {
          (a.append ? appendFileSync : writeFileSync)(a.path, a.content, "utf8");
          return { text: "写入成功" };
        },
        policyDecide: () => ({ decision: "allow" }), jitForPath: () => [],
      });
      assert.equal(result.stop, undefined, `第 ${i + 1} 块内容不同，应继续`);
      assert.equal(result.toolPlan[0].status, "completed");
    }
    assert.equal(readFileSync(path, "utf8"), chunks.join(""));
    assert.equal(history.length, chunks.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit 同一路径中不同 SVG 片段不得误判循环", async () => {
  const history = [], stuckEvents = [], seenCalls = new Map();
  for (let i = 0; i < 4; i++) {
    const result = await runYuanshuToolRound({
      toolCalls: [tc("edit", { path: "page.html", old_string: `part-${i}`, new_string: `<svg><text>${i}</text></svg>` })],
      history, stuckEvents, seenCalls, execute: async () => ({ text: "已修改" }),
      policyDecide: () => ({ decision: "allow" }), jitForPath: () => [],
    });
    assert.equal(result.stop, undefined);
  }
});

test("runYuanshuToolRound：已 abort 的未启动工具不执行", async () => {
  const ran = [];
  const ac = new AbortController();
  ac.abort();
  const history = [];
  const r = await runYuanshuToolRound({
    toolCalls: [tc("read", { path: "a.txt" })],
    history,
    execute: async (name) => { ran.push(name); return { text: "ok" }; },
    signal: ac.signal,
    seenCalls: new Map(),
    policyDecide: () => ({ decision: "allow" }),
    jitForPath: () => [],
  });
  assert.equal(ran.length, 0);
  assert.equal(history[0].content, ABORTED_MARKER);
  assert.ok(!r.stop);
});

test("runYuanshuToolRound：策略 deny 不调用执行器", async () => {
  const ran = [];
  const history = [];
  await runYuanshuToolRound({
    toolCalls: [tc("bash", { command: "rm -rf /" })],
    history,
    execute: async (name) => { ran.push(name); return { text: "ok" }; },
    seenCalls: new Map(),
    policyDecide: () => ({ decision: "deny", note: "危险操作" }),
    jitForPath: () => [],
  });
  assert.equal(ran.length, 0);
  assert.match(String(history[0].content), /系统拦截/);
});

test("runYuanshuToolRound：返回可恢复的 toolPlan 及完成状态", async () => {
  const history = [];
  const r = await runYuanshuToolRound({
    toolCalls: [tc("read", { path: "README.md" }, "call-1")],
    history,
    execute: async () => ({ text: "ok" }),
    seenCalls: new Map(),
    policyDecide: () => ({ decision: "allow" }),
    jitForPath: () => [],
  });
  assert.equal(r.toolPlan.length, 1);
  assert.deepEqual(r.toolPlan[0].args, { path: "README.md" });
  assert.equal(r.toolPlan[0].id, "call-1");
  assert.equal(r.toolPlan[0].name, "read");
  assert.equal(r.toolPlan[0].status, "completed");
  assert.equal(r.toolPlan[0].isError, false);
});

test("toolCallsFromPlan：恢复时只重建未完成步骤并保留参数", () => {
  assert.deepEqual(toolCallsFromPlan([
    { id: "done", name: "read", args: { path: "done.txt" }, status: "completed" },
    { id: "legacy", name: "read", status: "pending" },
    { id: "pending", name: "write", args: { path: "next.txt", content: "x" }, status: "pending" },
    { id: "uncertain", name: "bash", args: { command: "echo hi" }, status: "uncertain" },
  ]), [
    { id: "pending", type: "function", function: { name: "write", arguments: '{"path":"next.txt","content":"x"}' } },
    { id: "uncertain", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } },
  ]);
});

test("runYuanshuToolRound：相同成功调用 3 次停循环", async () => {
  const seenCalls = new Map();
  const history = [];
  const args = { path: "a.svg", content: "<svg></svg>" };
  for (let i = 0; i < 2; i++) {
    const r = await runYuanshuToolRound({
      toolCalls: [tc("write", args, `w${i}`)],
      history,
      execute: async () => ({ text: "ok" }),
      seenCalls,
      policyDecide: () => ({ decision: "allow" }),
      jitForPath: () => [],
    });
    assert.ok(!r.stop);
  }
  const third = await runYuanshuToolRound({
    toolCalls: [tc("write", args, "w3")],
    history,
    execute: async () => ({ text: "ok" }),
    seenCalls,
    policyDecide: () => ({ decision: "allow" }),
    jitForPath: () => [],
  });
  assert.match(third.stop?.error || "", /循环/);
});

test("attachYuanshuCodeTool 把 run_code 挂进工具表", () => {
  const tools = [];
  attachYuanshuCodeTool(tools, {
    runCodeToolDef: () => ({
      name: "run_code",
      description: "编排多步",
      parameters: { type: "object", properties: { program: { type: "string" } } },
      handler: async () => ({ text: "ok" }),
    }),
  });
  assert.equal(tools[0].function.name, "run_code");
  attachYuanshuCodeTool(tools, { runCodeToolDef: () => ({ name: "run_code", handler: async () => ({ text: "x" }) }) });
  assert.equal(tools.length, 1, "不得重复挂");
});

test("unifiedChat 工具轮必须走 runYuanshuToolRound；handleUnifiedChat 启动时 initEngine", () => {
  const src = readFileSync(join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const start = src.indexOf("export async function unifiedChat");
  const fn = src.slice(start, start + 9000);
  assert.ok(fn.includes("runYuanshuToolRound"), "主循环不能再手写串行 await execute");
  const h = src.slice(src.indexOf("export async function handleUnifiedChat"), src.indexOf("export async function handleUnifiedChat") + 2500);
  // 2026-09-09：initEngine 热身升级为 ensureEngineInit（可观察可重试，见 yuanshu-engine-hardening）
  assert.ok(h.includes("ensureEngineInit"), "元枢开口先把自己的引擎热起来（ensureEngineInit），run_code 才进主工具表");
});
