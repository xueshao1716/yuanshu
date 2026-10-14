import { test } from "node:test";
import assert from "node:assert/strict";
import { validateToolArgs, toolSchemaIndex, argsErrorText } from "../../engine/tool-schema.mjs";
import { runYuanshuToolRound } from "../../engine/yuanshu-loop.mjs";

const writeSchema = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" } },
  required: ["path", "content"],
};

test("validateToolArgs：缺必填、类型错、enum 错都能报出", () => {
  assert.equal(validateToolArgs(writeSchema, { path: "a", content: "b" }).ok, true);
  const missing = validateToolArgs(writeSchema, { path: "a" });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /content 为必填/);
  assert.match(validateToolArgs(writeSchema, { path: 1, content: "b" }).errors[0], /path 应为 string/);
  const en = { type: "object", properties: { mode: { type: "string", enum: ["a", "b"] } } };
  assert.match(validateToolArgs(en, { mode: "c" }).errors[0], /mode 必须是/);
});

test("validateToolArgs：宽松策略不误杀", () => {
  assert.equal(validateToolArgs(writeSchema, { path: "a", content: "b", extra: 1 }).ok, true, "多余字段放行");
  assert.equal(validateToolArgs({ type: "object", properties: { n: { type: "integer" } } }, { n: "3" }).ok, true, "数字字符串放行");
  assert.equal(validateToolArgs(writeSchema, { path: "a", content: "b", append: "true" }).ok, true, "布尔字符串放行");
  assert.equal(validateToolArgs({ type: "object", properties: { x: { anyOf: [{ type: "string" }, { type: "number" }] } }, required: ["x"] }, { x: 5 }).ok, true, "anyOf 放行");
  assert.equal(validateToolArgs(undefined, { a: 1 }).ok, true, "无 schema 放行");
  assert.equal(validateToolArgs({ type: "object", properties: {} }, {}).ok, true, "无参工具放行");
});

test("validateToolArgs：嵌套对象和数组", () => {
  const s = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } } };
  assert.equal(validateToolArgs(s, { items: [{ id: "a" }] }).ok, true);
  assert.match(validateToolArgs(s, { items: [{}] }).errors[0], /items\[0\]\.id 为必填/);
});

test("toolSchemaIndex：兼容 OpenAI 与扁平两种定义", () => {
  const idx = toolSchemaIndex([{ type: "function", function: { name: "write", parameters: writeSchema } }, { name: "x", parameters: { type: "object" } }, { function: { name: "noparams" } }]);
  assert.ok(idx.has("write") && idx.has("x") && !idx.has("noparams"));
});

test("runYuanshuToolRound：参数不合法不执行，错误回给模型", async () => {
  let executed = 0;
  const history = [];
  const r = await runYuanshuToolRound({
    toolCalls: [{ id: "c1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "a.txt" }) } }],
    history,
    execute: async () => { executed++; return { text: "ok" }; },
    toolDefs: [{ type: "function", function: { name: "write", parameters: writeSchema } }],
    policyDecide: () => ({ decision: "allow" }),
  });
  assert.equal(executed, 0);
  assert.equal(r.toolPlan[0].isError, true);
  assert.match(history.at(-1).content, /\[参数校验\].*content 为必填/);
});

test("runYuanshuToolRound：未传 toolDefs 行为不变", async () => {
  let executed = 0;
  await runYuanshuToolRound({
    toolCalls: [{ id: "c1", type: "function", function: { name: "write", arguments: "{}" } }],
    history: [],
    execute: async () => { executed++; return { text: "ok" }; },
    policyDecide: () => ({ decision: "allow" }),
  });
  assert.equal(executed, 1);
});

test("argsErrorText：给模型的提示可操作", () => {
  assert.match(argsErrorText("write", ["path 为必填"]), /不要编造参数/);
});

test("validateToolArgs：必填字段允许 null 时，显式 null 不算缺失（培养设计 asset:null）", async () => {
  const { CULTIVATION_TOOL_SCHEMA } = await import("../../engine/cultivation/tool.mjs");
  const media = { description: "x", asset: null };
  const design = { name: "n", rationale: "r", goals: ["g"], curriculum: ["c"], temporaryExpression: "t", observation: "o", recovery: "r",
    appearance: media, clothing: media, voice: media, permissions: { model: "m", tools: [], dataScopes: [], remote: false, costUpperBoundCents: 0 }, protectedProposalRefs: [] };
  const ok = validateToolArgs(CULTIVATION_TOOL_SCHEMA.function.parameters, { action: "design.submit", payload: { design } });
  assert.deepEqual(ok.errors, []);
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  assert.equal(validateToolArgs(schema, { a: null }).ok, false, "不允许 null 的必填字段仍然拦截");
});
