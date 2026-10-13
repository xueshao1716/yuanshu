import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createMcpManager, mcpToolToSchema } from "../../engine/mcp-client.mjs";
import { toolSandboxNeed } from "../../engine/yuanshu-sandbox.mjs";

function fakeServer(tag, tools) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body || "{}");
        const reply = (result) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
        if (method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {} });
        if (method === "tools/list") return reply({ tools });
        if (method === "tools/call") return reply({ content: [{ type: "text", text: `${tag}:${params.name}` }] });
        reply({});
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/mcp` }));
  });
}

test("MCP 多 server 同名工具：不丢失、各自路由到正确 server", async () => {
  const a = await fakeServer("A", [{ name: "search", description: "a", inputSchema: { type: "object" } }]);
  const b = await fakeServer("B", [{ name: "search", description: "b", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
  try {
    const mgr = createMcpManager({ wsRoot: () => process.cwd() });
    await mgr.connect({ name: "srvA", url: a.url, transport: "streamable-http" });
    await mgr.connect({ name: "srvB", url: b.url, transport: "streamable-http" });
    const tools = mgr.allTools();
    assert.equal(tools.length, 2);
    const names = tools.map((t) => t.exposedName).sort();
    assert.deepEqual(names, ["search", "srvB__search"]);
    const first = tools.find((t) => t.exposedName === "search");
    const second = tools.find((t) => t.exposedName === "srvB__search");
    assert.equal(first.serverName, "srvA");
    assert.equal((await mgr.callTool(first.exposedName, {})).text, "A:search");
    assert.equal((await mgr.callTool(second.exposedName, {})).text, "B:search");
    assert.equal(mcpToolToSchema(second).function.name, "mcp_srvB__search");
    assert.equal(toolSandboxNeed("mcp_srvB__search"), "read-only", "readOnlyHint 按暴露名登记");
    assert.equal(toolSandboxNeed("mcp_search"), "danger-full-access");
  } finally {
    a.srv.close(); b.srv.close();
  }
});
