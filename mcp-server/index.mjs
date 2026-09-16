// 元枢 MCP Server —— 把小语（元枢）的能力暴露给 NomiFun 等 MCP 客户端（2026-08-20）
// 工具：pi_chat（对话）/ pi_read_file / pi_write_file / pi_generate_image / pi_list_sessions / pi_workspace_tree / pi_deliver
// 传输：stdio（NomiFun /mcp 添加 stdio server 即可）
// 环境变量：PI_WEB_URL（默认 http://127.0.0.1:8787）、PI_WEB_TOKEN（必填，元枢的 .token）
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PI_WEB = process.env.PI_WEB_URL || "http://127.0.0.1:8787";
const TOKEN = process.env.PI_WEB_TOKEN || "";

if (!TOKEN) {
  console.error("[pi-mcp] 缺少 PI_WEB_TOKEN 环境变量（元枢的 .token）");
  process.exit(1);
}

const server = new McpServer({
  name: "yuanshu (元枢)",
  version: "2.43.0",
});

// ── HTTP 辅助 ──
async function api(path, opts = {}) {
  const r = await fetch(PI_WEB + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`元枢 HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  return r;
}

// 收集 /api/chat 的 SSE 直到 done，返回完整回复
async function chatCollect(body) {
  const r = await api("/api/chat", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text();
  // SSE 解析：event: delta / data: {...}，拼 text
  let full = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        const d = JSON.parse(line.slice(6));
        if (d.text) full += d.text;
      } catch {}
    }
  }
  return full || "(空回复)";
}

// ── 工具注册 ──

// 1. 对话（给小语发消息）
server.tool(
  "pi_chat",
  "给小语（元枢）发一条消息，返回她的回复。用于让小语分析/执行任务。",
  { message: z.string().describe("发给小语的消息"), sessionId: z.string().optional().describe("会话 ID（可选，留空自动新建）") },
  async ({ message, sessionId }) => {
    const body = { message, model: "auto" };
    if (sessionId) {
      body.sessionId = sessionId;
    } else {
      // 先建会话（避免无 session 时 /api/chat 的匿名路径不确定）
      const r = await api("/api/sessions", { method: "POST", body: JSON.stringify({ name: "MCP 会话" }) });
      const created = await r.json();
      body.sessionId = created.id;
    }
    const reply = await chatCollect(body);
    return { content: [{ type: "text", text: reply }] };
  }
);

// 2. 读文件
server.tool(
  "pi_read_file",
  "读元枢工作空间里的文件",
  { path: z.string().describe("文件路径（相对工作空间 D:\\pi-workspace）") },
  async ({ path }) => {
    const r = await api("/api/ws/read?path=" + encodeURIComponent(path));
    const data = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(data).slice(0, 8000) }] };
  }
);

// 3. 写文件
server.tool(
  "pi_write_file",
  "写文件到元枢工作空间",
  { path: z.string(), content: z.string() },
  async ({ path, content }) => {
    const r = await api("/api/ws/write", { method: "POST", body: JSON.stringify({ path, content }) });
    const data = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

// 4. 出图
server.tool(
  "pi_generate_image",
  "让元枢生成图片（保存到工作空间 生成物/ 目录）",
  { prompt: z.string().describe("图片描述"), provider: z.string().optional(), modelId: z.string().optional(), size: z.string().optional() },
  async ({ prompt, provider, modelId, size }) => {
    const body = { prompt, size: size || "1024x1024" };
    if (provider) body.provider = provider;
    if (modelId) body.modelId = modelId;
    const r = await api("/api/image", { method: "POST", body: JSON.stringify(body) });
    const data = await r.json();
    return { content: [{ type: "text", text: `图片已生成: ${JSON.stringify(data).slice(0, 500)}` }] };
  }
);

// 5. 会话列表
server.tool(
  "pi_list_sessions",
  "列出元枢的会话",
  {},
  async () => {
    const r = await api("/api/sessions");
    const data = await r.json();
    const sess = (data.sessions || data || []).slice(0, 15).map(s => `- ${s.id.slice(0, 8)} ${s.name || ""}`);
    return { content: [{ type: "text", text: sess.join("\n") || "(无会话)" }] };
  }
);

// 6. 工作空间浏览
server.tool(
  "pi_workspace_tree",
  "浏览元枢工作空间目录",
  { path: z.string().optional().describe("目录路径（默认根）") },
  async ({ path }) => {
    const r = await api("/api/ws/tree?path=" + encodeURIComponent(path || ""));
    const data = await r.json();
    const items = (data.items || []).slice(0, 20).map(i => `${i.isDir ? "📁" : "📄"} ${i.name}`);
    return { content: [{ type: "text", text: items.join("\n") || "(空目录)" }] };
  }
);

// 7. 交付
server.tool(
  "pi_deliver",
  "把工作空间文件交付给用户",
  { path: z.string().describe("要交付的文件/目录路径") },
  async ({ path }) => {
    const r = await api("/api/ws/deliver", { method: "POST", body: JSON.stringify({ path }) });
    const data = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

// ── 启动（stdio）──
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[pi-mcp] 元枢 MCP server 已启动（stdio）");
