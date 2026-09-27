// ===== gateway.mjs —— Gateway 2.0 组装器（dsh 无特权核心思想的落点）=====
// 设计：Gateway = PluginRegistry + 各组件插件 + 统一入口。
//   无特权核心：model-adapter / tool-registry / session-store / agent-loop 全是插件，
//   可动态注册/卸载/替换；Gateway 只负责组装和暴露便捷 API。
//
// 用法（宿主组装）：
//   import { createGateway } from "./engine/gateway.mjs";
//   const gw = await createGateway({
//     httpFetch, authReader, modelReader, resolveAuth,  // 注入宿主能力
//     defaultExecutor,                                   // 注入现有工具执行链
//     getModel: () => currentModel,
//   });
//   await gw.init();            // 挂载全部内置插件
//   const r = await gw.chat("你好", { history, tools: true });
//   await gw.plugins.unregister("agent-loop:standard"); // 动态卸载（演示可替换）

import { PluginRegistry } from "./plugin-registry.mjs";
import { HttpModelAdapter } from "./model-adapter.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { MemorySessionStore, FileSessionStore } from "./session-store.mjs";
import { StandardAgentLoop } from "./agent-loop.mjs";

export async function createGateway(options = {}) {
  const registry = new PluginRegistry({ ctx: options.ctx });

  // ── 内置组件插件 ──
  // 1. 模型适配器（默认 HTTP/OpenAI 兼容；可再注册更多，Gateway 用最后一个挂载的）
  const adapter = new HttpModelAdapter({
    id: options.adapterId || "http",
    name: options.adapterName || "HTTP (OpenAI 兼容)",
    httpFetch: options.httpFetch,
    authReader: options.authReader,
    modelReader: options.modelReader,
    resolveAuth: options.resolveAuth,
  });
  registry.register({
    id: "model-adapter:http",
    name: "模型适配器: HTTP (OpenAI 兼容)",
    version: adapter.version,
    deps: [],
    mount: () => adapter,
  });

  // 2. 工具注册表（宿主注入 defaultExecutor 复用现有执行链）
  const tools = new ToolRegistry({
    id: options.toolsId || "default",
    name: options.toolsName || "默认工具注册表",
    defaultExecutor: options.defaultExecutor,
  });
  registry.register({
    id: "tool-registry:default",
    name: "工具注册表: 默认",
    version: tools.version,
    deps: [],
    mount: () => tools,
  });

  // 3. 会话存储（默认内存；可选文件）
  const store = options.sessionStore || (options.sessionDir
    ? new FileSessionStore({ dir: options.sessionDir })
    : new MemorySessionStore());
  registry.register({
    id: `session-store:${store.id}`,
    name: `会话存储: ${store.name}`,
    version: store.version,
    deps: [],
    mount: () => store,
  });

  // 4. Agent 循环（标准工具循环）
  const loop = new StandardAgentLoop({
    id: options.loopId || "standard",
    name: options.loopName || "标准工具循环",
    getModel: options.getModel || (() => null),
    maxTurns: options.maxTurns,
  });
  registry.register({
    id: "agent-loop:standard",
    name: "Agent 循环: 标准工具循环",
    version: loop.version,
    deps: ["model-adapter:http", "tool-registry:default"],
    mount: () => loop,
  });

  // ── 挂载全部 ──
  await registry.mountAll();

  // ── Gateway 便捷 API ──
  const gw = {
    registry,
    adapter,
    tools,
    store,
    loop,

    // 引擎状态（前端面板展示）
    status() {
      return {
        components: {
          modelAdapter: { id: adapter.id, name: adapter.name },
          toolRegistry: { id: tools.id, name: tools.name, tools: tools.names() },
          sessionStore: { id: store.id, name: store.name },
          agentLoop: { id: loop.id, name: loop.name },
        },
        plugins: registry.list(),
      };
    },

    // 对话入口：走标准循环（模型 + 工具 + 会话）
    async chat(message, opts = {}) {
      const model = opts.model || options.getModel?.() || null;
      let history = opts.history || [];
      if (opts.sessionId) {
        const s = await store.load(opts.sessionId);
        if (s?.history) history = s.history;
      }
      const r = await loop.run({
        message,
        history,
        model,
        tools: opts.tools === false ? null : tools,
        opts: {
          modelAdapter: adapter,
          onTool: opts.onTool,
          onToolEnd: opts.onToolEnd,
          signal: opts.signal,
          params: opts.params,
          system: opts.system,
          timeout: opts.timeout,
        },
      });
      if (opts.sessionId && !r.error) {
        await store.save({ id: opts.sessionId, title: opts.title || String(message).slice(0, 40), history: r.history, updatedAt: Date.now() });
      }
      return r;
    },

    // 动态注册插件（前端面板用）：def 直接进 registry
    async registerPlugin(def) {
      registry.register(def);
      const inst = await registry._mountOne(def);
      return { id: def.id, mounted: true };
    },

    async unregisterPlugin(id) {
      return registry.unregister(id);
    },

    async dispose() {
      await registry.dispose();
    },
  };

  return gw;
}

export default createGateway;
