import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { initUnifiedChat, unifiedChat } from "../../engine/unified-chat.mjs";
import { initDshKeys } from "../../engine/dsh-keys.mjs";
import { TRUNCATED_TOOL_ERROR } from "../../engine/yuanshu-stability.mjs";

function sseMessage(message) {
  return `data: ${JSON.stringify({ choices: [{ message }] })}\n\ndata: [DONE]\n\n`;
}

test("unifiedChat：截断工具参数后保留已完成步骤并继续任务", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (requests === 1) {
        res.end(sseMessage({
          content: null,
          tool_calls: [{ id: "call-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "out.txt", content: "第一步" }) } }],
        }));
      } else if (requests === 2) {
        // 模拟历史事故：模型已经开始下一步工具调用，但参数在输出边界处被截断。
        res.end(sseMessage({
          content: "继续生成文件",
          tool_calls: [{ id: "call-bad", type: "function", function: { name: "write", arguments: '{"path":"out.txt","content":"第二步' } }],
        }));
      } else {
        res.end(sseMessage({ content: "已完成全部文件生成。" }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const model = { provider: "mock-recovery", id: "mock", baseUrl: `http://127.0.0.1:${port}`, api: "openai-completions" };
  const executed = [];
  const readJsonFile = file => file === "mock-auth.json" ? { "mock-recovery": { key: "test" } } : { "mock-recovery": { models: [model] } };
  initDshKeys({ authPath: "mock-auth.json", modelsPath: "mock-models.json", readJsonFile });
  initUnifiedChat({
    authPath: "mock-auth.json",
    modelsPath: "mock-models.json",
    readJsonFile,
    getModelList: () => [model],
    getDefaultModel: () => model,
    UNIFIED_TOOLS: [{ type: "function", function: { name: "write", description: "写文件", parameters: { type: "object" } } }],
    executeUnifiedTool: async (name, args) => { executed.push({ name, args }); return { text: `已执行 ${name}`, isError: false }; },
  });

  try {
    const result = await unifiedChat(model, [{ role: "user", content: "继续生成文件" }], { maxTurns: 5 });
    assert.equal(result.error, undefined);
    assert.equal(result.text, "已完成全部文件生成。");
    assert.deepEqual(executed, [{ name: "write", args: { path: "out.txt", content: "第一步" } }]);
    assert.equal(requests, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("unifiedChat：工具轮次耗尽时返回可恢复错误而非伪完成", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseMessage({ content: `阶段 ${requests}`, tool_calls: [{ id: `call-${requests}`, type: "function", function: { name: "write", arguments: JSON.stringify({ path: `step-${requests}.txt`, content: "x" }) } }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const model = { provider: "mock-max-turns", id: "mock", baseUrl: `http://127.0.0.1:${port}`, api: "openai-completions" };
  const readJsonFile = file => file === "mock-auth.json" ? { "mock-max-turns": { key: "test" } } : { "mock-max-turns": { models: [model] } };
  initDshKeys({ authPath: "mock-auth.json", modelsPath: "mock-models.json", readJsonFile });
  initUnifiedChat({ authPath: "mock-auth.json", modelsPath: "mock-models.json", readJsonFile, getModelList: () => [model], getDefaultModel: () => model, UNIFIED_TOOLS: [{ type: "function", function: { name: "write", parameters: { type: "object" } } }], executeUnifiedTool: async () => ({ text: "已执行", isError: false }) });
  try {
    const result = await unifiedChat(model, [{ role: "user", content: "持续执行" }], { maxTurns: 2 });
    assert.equal(result.error, TRUNCATED_TOOL_ERROR, "截断到顶时要给出可执行的建议（不再把锅甩给用户）");
    assert.equal(result.partial, true);
    assert.ok(Array.isArray(result.history));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
