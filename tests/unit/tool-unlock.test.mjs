// 按需取工具：被工具档收起的只给目录，点名后本会话一直带着（2026-11-19）
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeTools, requestToolExec, unlockedFor, _resetToolUnlock, REQUEST_TOOL_NAME } from "../../engine/tool-unlock.mjs";
import { filterToolsByTier } from "../../engine/brain-regions.mjs";
import { toolSandboxNeed } from "../../engine/yuanshu-sandbox.mjs";

const T = (name, description = `${name} 的用途。更多说明`) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: {} } } });
const ALL = [T("read"), T("bash"), T("run_code", "跑一段代码。细节"), T("canvas_write"), T("mcp_x_a"), T("tp_y_b")];
const names = (ts) => ts.map((t) => t.function.name);
const kept = () => filterToolsByTier(ALL, { tooling: 0.5 });

test("收起的工具只给一行目录，并附上 request_tool", () => {
  _resetToolUnlock();
  const { tools, catalog } = composeTools(ALL, kept(), "s1");
  assert.deepEqual(names(tools), ["read", "bash", REQUEST_TOOL_NAME]);
  assert.match(catalog, /run_code：跑一段代码/);
  assert.doesNotMatch(catalog, /细节/);
  assert.match(catalog, /另有 2 个 MCP/);
});

test("点名后下一次组装就带上，且同会话一直保留；别的会话不受影响", () => {
  _resetToolUnlock();
  composeTools(ALL, kept(), "s1");
  const r = requestToolExec({ names: ["run_code", "nope"] }, { sessionId: "s1" });
  assert.equal(r.isError, false);
  assert.match(r.text, /已取回：run_code/);
  assert.match(r.text, /没找到：nope/);
  assert.deepEqual(unlockedFor("s1"), ["run_code"]);
  assert.ok(names(composeTools(ALL, kept(), "s1").tools).includes("run_code"));
  assert.ok(!names(composeTools(ALL, kept(), "s2").tools).includes("run_code"));
});

test("取不回这一轮原始表里没有的工具（值班/唤醒的受限表）", () => {
  _resetToolUnlock();
  const wake = [T("read"), T("run_code")];
  composeTools(wake, filterToolsByTier(wake, { tooling: 0.5 }), "w1");
  const r = requestToolExec({ names: ["bash"] }, { sessionId: "w1" });
  assert.equal(r.isError, true);
  // 即便同会话在别处取回过 bash，受限表里也不会出现
  const { tools } = composeTools(wake, [T("read")], "w1");
  assert.ok(!names(tools).includes("bash"));
});

test("全部取回后不再附 request_tool 和目录；没有会话就不提供", () => {
  _resetToolUnlock();
  composeTools(ALL, kept(), "s1");
  requestToolExec({ names: ["run_code", "canvas_write", "mcp_x_a", "tp_y_b"] }, { sessionId: "s1" });
  const r = composeTools(ALL, kept(), "s1");
  assert.equal(r.catalog, "");
  assert.ok(!names(r.tools).includes(REQUEST_TOOL_NAME));
  assert.equal(composeTools(ALL, kept(), "").catalog, "");
});

test("request_tool 本身按只读算，不要求更高沙箱档", () => {
  assert.equal(toolSandboxNeed("request_tool", {}), "read-only");
});
