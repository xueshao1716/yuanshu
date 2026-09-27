// engine/mcp-server.mjs —— 元枢 MCP HTTP 端点（2026-08-20）
// 把元枢的“认知层”能力暴露给 NomiFun 等 MCP 客户端：
//   pi_model_route  → Auto 路由（模型选择/降级建议）
//   pi_memory_recall → 记忆召回（经验/记忆日志）
//   pi_emotion_state → 情绪引擎快照
//   pi_chat          → 对话（SSE 收集）
//   pi_read_file / pi_write_file / pi_workspace_tree / pi_deliver
// 传输：HTTP POST /mcp（JSON-RPC 2.0：initialize / tools/list / tools/call）
// 认证：与元枢相同（Bearer token）
import { extractMessages, extractText } from "./session-utils.mjs";

// 依赖注入（server.mjs 启动时注入）
let _getModelRouter = null;   // model-router 引用（classifyTaskComplexity/routeForAuto）
let _memoryApi = null;        // engine/memory.mjs
let _emotion = null;          // engine/emotion.mjs
let _getDefaultModel = () => null;
let _getWsRoot = () => process.cwd(); // M1：兜底可移植（server.mjs 启动时会注入真实 wsRoot）
let _json = null;             // http-utils json

export function initMcpServer({ modelRouter, memoryApi, emotion, getDefaultModel, wsRoot, json }) {
  _getModelRouter = modelRouter;
  _memoryApi = memoryApi;
  _emotion = emotion;
  if (getDefaultModel) _getDefaultModel = getDefaultModel;
  if (wsRoot) _getWsRoot = wsRoot;
  if (json) _json = json;
}

// ── 工具定义 ──
const TOOLS = [
  {
    name: "pi_model_route",
    description: "调用元枢的 Auto 路由：根据任务文本给出建议模型（flash/pro + 原因）。NomiFun 选模型时可参考。",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "任务描述" } } },
  },
  {
    name: "pi_memory_recall",
    description: "召回元枢的记忆（经验库/记忆日志，关键词匹配）。",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "检索关键词" }, max: { type: "number" } } },
  },
  {
    name: "pi_emotion_state",
    description: "获取元枢情绪引擎当前快照（VAD/情绪标签）。",
    inputSchema: { type: "object", properties: { session: { type: "string", description: "会话标识（可选）" } } },
  },
  {
    name: "pi_chat",
    description: "给小语（元枢）发消息并返回完整回复。",
    inputSchema: { type: "object", properties: { message: { type: "string" }, sessionId: { type: "string" } }, required: ["message"] },
  },
  {
    name: "pi_read_file",
    description: "读元枢工作空间文件",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "pi_write_file",
    description: "写文件到元枢工作空间",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "pi_workspace_tree",
    description: "浏览元枢工作空间目录",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "pi_pending_list",
    description: "列出待审改动（agent 提的文件改动，等人接受/拒绝）。任何改文件的 agent 都应先提议、由人决定。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pi_pending_propose",
    description: "提议一次文件改动（不写盘）：把目标路径与新内容登记进待审区，返回 diff 统计；人接受后才生效。",
    inputSchema: { type: "object", properties: { target: { type: "string", description: "相对工作区的目标文件路径" }, content: { type: "string", description: "新的完整内容" }, note: { type: "string" } }, required: ["target", "content"] },
  },
  {
    name: "pi_pending_accept",
    description: "接受一条待审改动（真正写盘，覆盖前留 .bak-apply，并写审计）。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "pi_pending_reject",
    description: "拒绝一条待审改动（什么都不写，仅记录）。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id"] },
  },
  {
    name: "pi_history_list",
    description: "列出所有版本回溯点（.bak* 备份 + 天团运行快照），用于「随时能退回去」。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pi_history_rollback",
    description: "回滚到某个备份（回滚前把当前内容另存 .bak-rollback-<时间>，并写审计）。",
    inputSchema: { type: "object", properties: { backup: { type: "string", description: "备份文件相对路径（来自 pi_history_list）" } }, required: ["backup"] },
  },
  {
    name: "pi_deliver",
    description: "把工作空间文件标记为交付",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

// MCP 工具若要调用元枢自己的 HTTP 接口，需要本机基址与令牌（同进程，直接走 127.0.0.1）。
function _base() { return "http://127.0.0.1:" + (process.env.PORT || 8787); }
function _auth() { return { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.YUANSHU_TOKEN || "love#1126469194") }; }

// ── 工具执行 ──
async function callTool(name, args, ctx) {
  switch (name) {
    case "pi_model_route": {
      const text = String(args.task || "");
      const router = _getModelRouter;
      if (!router) return "模型路由未注入";
      const cl = router.classifyTaskComplexity ? router.classifyTaskComplexity(text) : null;
      const auto = router.routeForAuto ? router.routeForAuto(text) : null;
      const lines = [];
      if (cl) lines.push(`复杂度: ${cl.level} (score=${cl.score})${cl.reasons?.length ? " [" + cl.reasons.join("/") + "]" : ""}`);
      if (auto?.model) lines.push(`建议模型: ${auto.model.provider}/${auto.model.id}`);
      if (auto?.reasons?.length) lines.push(`原因: ${auto.reasons.join(" / ")}`);
      if (!lines.length) lines.push("路由不可用");
      return lines.join("\n");
    }
    case "pi_memory_recall": {
      const mem = _memoryApi;
      const q = String(args.query || "");
      const max = Number(args.max || 5);
      if (!mem) return "记忆模块未注入";
      const out = [];
      try {
        const rel = mem.searchMemoryLog ? mem.searchMemoryLog(_getWsRoot(), q, max) : [];
        if (rel?.length) out.push(`【相关记忆】\n${rel.slice(0, max).join("\n")}`);
      } catch {}
      try {
        const recent = mem.loadRecentMemory ? mem.loadRecentMemory(_getWsRoot(), 3) : [];
        if (recent?.length) out.push(`【最近记忆】\n${recent.slice(0, 3).join("\n")}`);
      } catch {}
      return out.join("\n\n") || "(无匹配记忆)";
    }
    case "pi_emotion_state": {
      const emo = _emotion;
      if (!emo) return "情绪引擎未注入";
      try {
        const snap = emo.getSnapshot(String(args.session || "new"));
        return JSON.stringify(snap, null, 1);
      } catch (e) {
        return "情绪快照失败: " + String(e?.message || e);
      }
    }
    case "pi_chat": {
      const { chatCollect } = await import("./mcp-chat.mjs");
      const body = { message: String(args.message || ""), model: "auto" };
      if (args.sessionId) body.sessionId = String(args.sessionId);
      return await chatCollect(body, ctx);
    }
    case "pi_read_file": {
      const r = await ctx.api("/api/ws/read?path=" + encodeURIComponent(String(args.path)));
      const data = await r.json();
      return JSON.stringify(data).slice(0, 8000);
    }
    case "pi_write_file": {
      const r = await ctx.api("/api/ws/write", { method: "POST", body: JSON.stringify({ path: String(args.path), content: String(args.content) }) });
      return JSON.stringify(await r.json());
    }
    case "pi_workspace_tree": {
      const r = await ctx.api("/api/ws/tree?path=" + encodeURIComponent(String(args.path || "")));
      const data = await r.json();
      return (data.items || []).slice(0, 20).map(i => `${i.isDir ? "📁" : "📄"} ${i.name}`).join("\n") || "(空目录)";
    }
    case "pi_pending_list": {
      const r = await fetch(_base() + "/api/pending", { headers: _auth() });
      const j = await r.json();
      const items = (j.items || []);
      return items.length ? items.map((x) => `${x.id}  ${x.target}  +${x.added ?? "?"}/-${x.removed ?? "?"}  by ${x.by}`).join("\n") : "(没有待审改动)";
    }
    case "pi_pending_propose": {
      const r = await fetch(_base() + "/api/pending", { method: "POST", headers: _auth(), body: JSON.stringify({ target: String(args.target || ""), content: String(args.content || ""), by: String(args.by || "mcp"), note: String(args.note || "") }) });
      const j = await r.json();
      return JSON.stringify(j);
    }
    case "pi_pending_accept": {
      const r = await fetch(_base() + "/api/pending/" + encodeURIComponent(String(args.id)) + "/accept", { method: "POST", headers: _auth() });
      return JSON.stringify(await r.json());
    }
    case "pi_pending_reject": {
      const r = await fetch(_base() + "/api/pending/" + encodeURIComponent(String(args.id)) + "/reject", { method: "POST", headers: _auth(), body: JSON.stringify({ reason: String(args.reason || "mcp 拒绝") }) });
      return JSON.stringify(await r.json());
    }
    case "pi_history_list": {
      const r = await fetch(_base() + "/api/history", { headers: _auth() });
      const j = await r.json();
      const b = (j.backups || []).slice(0, 20).map((x) => `${x.backup}  →  ${x.target}`);
      const runs = (j.runs || []).slice(0, 10).map((x) => `运行快照 ${x.id}（${(x.deliveries || []).length} 个交付）`);
      return [...b, ...runs].join("\n") || "(没有回溯点)";
    }
    case "pi_history_rollback": {
      const r = await fetch(_base() + "/api/history/rollback", { method: "POST", headers: _auth(), body: JSON.stringify({ backup: String(args.backup || "") }) });
      return JSON.stringify(await r.json());
    }
    case "pi_deliver": {
      const r = await ctx.api("/api/ws/deliver", { method: "POST", body: JSON.stringify({ path: String(args.path) }) });
      return JSON.stringify(await r.json());
    }
    default:
      return "未知工具: " + name;
  }
}

// ── JSON-RPC 处理 ──
export async function handleMcp(req, res, ctx) {
  // 只处理 POST /mcp
  let body = "";
  for await (const chunk of req) body += chunk;
  let rpc;
  try {
    rpc = JSON.parse(body || "{}");
  } catch {
    return _json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
  }
  const id = rpc.id;
  try {
    switch (rpc.method) {
      case "initialize":
        return _json(res, 200, {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: rpc.params?.protocolVersion || "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "yuanshu (元枢)", version: "2.115.19" },
          },
        });
      case "notifications/initialized":
        return _json(res, 202, {});
      case "tools/list":
        return _json(res, 200, { jsonrpc: "2.0", id, result: { tools: TOOLS } });
      case "tools/call": {
        const name = rpc.params?.name;
        const args = rpc.params?.arguments || {};
        const result = await callTool(name, args, ctx);
        return _json(res, 200, {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: String(result).slice(0, 20000) }] },
        });
      }
      default:
        return _json(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + rpc.method } });
    }
  } catch (e) {
    return _json(res, 200, { jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message || e).slice(0, 200) } });
  }
}
