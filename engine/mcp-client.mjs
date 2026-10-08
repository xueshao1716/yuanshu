// engine/mcp-client.mjs —— MCP client，连接外部 MCP server（Windows-MCP 等），2026-10-08
// 支持 streamable-http 和 SSE 传输；动态发现工具并注册到元枢工具集。
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

// ── 持久化配置 ──────────────────────────────────────────────────────────────
export function getMcpConfigPath(wsRoot) {
  return path.join(wsRoot, '.yuanshu', 'mcp-servers.json');
}

export function loadMcpConfig(wsRoot) {
  try {
    const p = getMcpConfigPath(wsRoot);
    if (!fs.existsSync(p)) return { servers: [] };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return { servers: [] }; }
}

export function saveMcpConfig(wsRoot, cfg) {
  const p = getMcpConfigPath(wsRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── 单个 MCP server 连接 ─────────────────────────────────────────────────────
// 协议：JSON-RPC 2.0，通过 HTTP POST (streamable-http) 或 SSE 传输。
// Windows-MCP 默认是 streamable-http；SSE 也支持。

export function createMcpConnection({ url, name, transport = 'streamable-http' }) {
  let tools = [];        // 已发现的工具列表
  let connected = false;
  let error = null;

  // JSON-RPC over HTTP POST（streamable-http 模式）
  async function rpc(method, params = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`MCP server ${name} HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    // streamable-http 可能回 SSE 流，也可能直接回 JSON
    if (ct.includes('text/event-stream')) {
      return await readSseResponse(res);
    }
    const json = await res.json();
    if (json.error) throw new Error(`MCP ${name}: ${json.error.message || JSON.stringify(json.error)}`);
    return json.result;
  }

  // 读取 SSE 响应流，找第一条有 result 的消息
  async function readSseResponse(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(line.slice(5).trim());
          if (msg.result !== undefined) return msg.result;
          if (msg.error) throw new Error(`MCP ${name}: ${msg.error.message}`);
        } catch (e) { if (e.message.startsWith('MCP')) throw e; }
      }
    }
    throw new Error(`MCP ${name}: SSE 流结束无结果`);
  }

  // 初始化握手 + 发现工具
  async function connect() {
    try {
      // initialize 握手
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'yuanshu', version: '2.123.1' },
      });
      // 发现工具列表
      const result = await rpc('tools/list', {});
      tools = (result?.tools || []).map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        serverName: name,
      }));
      connected = true;
      error = null;
      return tools;
    } catch (e) {
      connected = false;
      error = e.message;
      tools = [];
      throw e;
    }
  }

  // 调用工具
  async function callTool(toolName, args = {}) {
    const result = await rpc('tools/call', { name: toolName, arguments: args });
    // MCP 工具结果格式：{ content: [{type, text|data}], isError? }
    return result;
  }

  const status = () => ({ name, url, transport, connected, error, toolCount: tools.length });
  const getTools = () => tools;

  return { connect, callTool, status, getTools };
}

// ── MCP 管理器：管理多个连接 ───────────────────────────────────────────────
export function createMcpManager({ wsRoot }) {
  const connections = new Map(); // name -> connection

  function load() {
    const cfg = loadMcpConfig(wsRoot);
    return cfg.servers || [];
  }

  function save(servers) {
    saveMcpConfig(wsRoot, { servers });
  }

  // 启动时连接所有已启用的 server
  async function bootAll() {
    const servers = load();
    const results = [];
    for (const s of servers) {
      if (!s.enabled) continue;
      try {
        const conn = createMcpConnection({ url: s.url, name: s.name, transport: s.transport || 'streamable-http' });
        await conn.connect();
        connections.set(s.name, conn);
        results.push({ name: s.name, ok: true, tools: conn.getTools().length });
      } catch (e) {
        results.push({ name: s.name, ok: false, error: e.message });
      }
    }
    return results;
  }

  // 连接单个 server
  async function connect(serverCfg) {
    const conn = createMcpConnection({ url: serverCfg.url, name: serverCfg.name, transport: serverCfg.transport || 'streamable-http' });
    await conn.connect();
    connections.set(serverCfg.name, conn);
    return conn.getTools();
  }

  // 断开单个 server
  function disconnect(name) {
    connections.delete(name);
  }

  // 所有已连接工具的扁平列表（去重）
  function allTools() {
    const list = [];
    for (const conn of connections.values()) {
      for (const t of conn.getTools()) list.push(t);
    }
    return list;
  }

  // 调用工具（找到对应 server 的连接转发）
  async function callTool(toolName, args = {}) {
    for (const conn of connections.values()) {
      const tools = conn.getTools();
      if (tools.some(t => t.name === toolName)) {
        const result = await conn.callTool(toolName, args);
        // 把 MCP content 数组转成文本
        if (result?.content) {
          const text = result.content.map(c => c.text || c.data || '').join('\n');
          return { text, isError: !!result.isError };
        }
        return { text: JSON.stringify(result), isError: false };
      }
    }
    throw new Error(`MCP 工具 ${toolName} 未找到已连接的 server`);
  }

  // 重连单个 server
  async function reconnect(name) {
    const servers = load();
    const cfg = servers.find(s => s.name === name);
    if (!cfg) throw new Error(`未找到 MCP server 配置：${name}`);
    disconnect(name);
    return await connect(cfg);
  }

  const status = () => {
    const servers = load();
    return servers.map(s => {
      const conn = connections.get(s.name);
      return conn ? { ...conn.status(), enabled: s.enabled } : { name: s.name, url: s.url, enabled: s.enabled, connected: false, error: null, toolCount: 0 };
    });
  };

  return { bootAll, connect, disconnect, reconnect, allTools, callTool, status, load, save };
}

// ── 把 MCP 工具转成元枢工具 schema 格式 ─────────────────────────────────────
export function mcpToolToSchema(mcpTool) {
  return {
    type: 'function',
    function: {
      name: `mcp_${mcpTool.name}`,  // 加前缀避免和内置工具冲突
      description: `[MCP:${mcpTool.serverName}] ${mcpTool.description}`,
      parameters: mcpTool.inputSchema,
    },
    _mcpTool: mcpTool.name,           // 原始工具名，供执行时还原
    _mcpServer: mcpTool.serverName,
  };
}

export function mcpToolName(name) {
  // 执行时把 mcp_ 前缀去掉，找对应的 MCP 工具
  return name.startsWith('mcp_') ? name.slice(4) : name;
}
