// ===== unified-chat-tools.test.mjs —— 统一对话通道工具开关与参数修复单测 =====
// 背景（2026-08-31）：wawazz-claude（anthropic-messages）被 8-21 glm-5.3 补丁一刀切 noTools；
// 且 wawazz 中转返回的 tool_calls.arguments 带 "{}" 脏前缀（'{}{"path":...}'），JSON.parse 直接失败。
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeToolCallList, repairToolArgs, modelAllowsTools, createRunHistorySnapshot, restoreRunHistorySnapshot, formatSessionHistory } from "../../engine/unified-chat.mjs";
import { persistYuanshuToolTrace } from "../../engine/yuanshu-session.mjs";
import { resetProjectionCounts, countProjection, FULL_SENDS, TURN_END_RESULT_CAP } from "../../engine/reasonix-tools.mjs";

test("repairToolArgs：中转脏前缀修复", (t) => {
  t.test('"{}{...}" 拼接前缀 → 剥离为合法 JSON', () => {
    assert.equal(repairToolArgs('{}{"path": "/tmp/a.txt"}'), '{"path": "/tmp/a.txt"}');
    assert.deepEqual(JSON.parse(repairToolArgs('{}{"path": "/tmp/a.txt"}')), { path: "/tmp/a.txt" });
  });
  t.test("正常 JSON 原样保留", () => {
    assert.equal(repairToolArgs('{"a":1}'), '{"a":1}');
    assert.equal(repairToolArgs("{}"), "{}");
    assert.equal(repairToolArgs(""), "");
  });
  t.test("多重空对象前缀也能修", () => {
    assert.deepEqual(JSON.parse(repairToolArgs('{}{}{"x":2}')), { x: 2 });
  });
});

test("sanitizeToolCallList：arguments 经过脏前缀修复", () => {
  const out = sanitizeToolCallList([
    { id: "t1", function: { name: "read", arguments: '{}{"path": "/tmp/a.txt"}' } },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0].function.arguments), { path: "/tmp/a.txt" });
});

test("modelAllowsTools：工具开关判定", (t) => {
  t.test("anthropic-messages 原生协议默认支持 tools", () => {
    assert.equal(modelAllowsTools({ api: "anthropic-messages" }), true);
  });
  t.test("anthropic-messages + compat.supportsTools:true 显式开启（wawazz-claude）", () => {
    assert.equal(modelAllowsTools({ api: "anthropic-messages", compat: { supportsTools: true } }), true);
  });
  t.test("openai-completions 默认开启", () => {
    assert.equal(modelAllowsTools({ api: "openai-completions" }), true);
    assert.equal(modelAllowsTools({}), true);
    assert.equal(modelAllowsTools(null), true);
  });
  t.test("compat.supportsTools:false 一律关闭", () => {
    assert.equal(modelAllowsTools({ api: "openai-completions", compat: { supportsTools: false } }), false);
  });
});

test("运行历史快照：保留系统提示与工具尾部，恢复时不重复追加用户消息", () => {
  const history = [
    { role: "system", content: "系统规则" },
    { role: "user", content: "需求" },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "完成" },
  ];
  const snapshot = createRunHistorySnapshot(history, { turn: 2, maxMessages: 4 });
  assert.equal(snapshot.v, 1);
  assert.equal(snapshot.turn, 2);
  assert.deepEqual(restoreRunHistorySnapshot(snapshot), history);
  assert.ok(JSON.stringify(snapshot).length < 10_000);
});

test("会话历史：工具调用与结果回灌到下一轮模型上下文", () => {
  assert.deepEqual(formatSessionHistory([
    { role: "user", text: "拼接视频" },
    { role: "assistant", text: "已找到素材", tools: [{ id: "t1", name: "bash", args: { command: "dir" }, output: "s1.mp4\ns2.mp4", isError: false }] },
  ]), [
    { role: "user", content: "拼接视频" },
    { role: "assistant", content: "已找到素材", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "dir" }) } }] },
    { role: "tool", tool_call_id: "t1", content: "s1.mp4\ns2.mp4" },
  ]);
});

test("会话落盘：当前轮工具轨迹可在下一轮恢复，且不会重复结果", () => {
  const saved = [];
  persistYuanshuToolTrace({ appendMessage: m => saved.push(m) }, [
    { role: "user", content: "继续" },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "dir" }) } }] },
    { role: "tool", tool_call_id: "t1", content: "s1.mp4", isError: false },
  ]);
  assert.equal(saved.filter(m => m.role === "assistant").length, 1);
  assert.equal(saved.filter(m => m.role === "toolResult").length, 1);
  assert.equal(saved[1].toolCallId, "t1");
});

test("会话历史：大结果前 FULL_SENDS 次投影给全文，之后才压缩（走真实默认策略）", () => {
  resetProjectionCounts();
  const long = `npm test\n${"z".repeat(TURN_END_RESULT_CAP + 500)}`;
  const hist = [{ role: "assistant", text: "跑测试", tools: [{ id: "t-long", name: "bash", args: { command: "npm test" }, output: long }] }];
  const projected = () => formatSessionHistory(hist).find(m => m.role === "tool").content;
  for (let i = 1; i <= FULL_SENDS; i++) assert.equal(projected(), long, `第 ${i} 次投影应是全文`);
  assert.match(projected(), /工具结果过长已压缩/, `第 ${FULL_SENDS + 1} 次起应压缩`);
});

test("会话历史：projectTool 可注入，注入时不碰全局计数", () => {
  resetProjectionCounts();
  const seen = [];
  const hist = [{ role: "assistant", text: "x", tools: [{ id: "t-inject", name: "bash", args: {}, output: "y".repeat(TURN_END_RESULT_CAP + 100) }] }];
  const out = formatSessionHistory(hist, { projectTool: t => { seen.push(t.id); return "INJECTED"; } });
  assert.deepEqual(seen, ["t-inject"], "注入的实现应被调用");
  assert.equal(out.find(m => m.role === "tool").content, "INJECTED");
  // 注入路径不该动模块级计数：直接数一次应仍是 1
  assert.equal(countProjection({ id: "t-inject" }, "whatever"), 1, "注入不应污染全局计数");
  // 非函数值要被忽略，回退到默认策略而不是崩
  assert.ok(formatSessionHistory(hist, { projectTool: null }).length > 0);
});

test("恢复后的备用模型不得重新携带旧快照", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const source = readFileSync(join(root, "engine", "unified-chat.mjs"), "utf8");
  assert.match(source, /chatOpts\.resumeToolPlan = null;\s*chatOpts\.resumeSnapshot = null;\s*chatOpts\.resumeCheckpointKind = null/);
  assert.match(source, /resumeSnapshot: null, resumeCheckpointKind: null, resumeToolPlan: null/);
});
