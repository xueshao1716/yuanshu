// ===== tool-registry.mjs —— Gateway 2.0 工具注册表（dsh ToolRegistry 思想沉淀）=====
// 设计：工具 = { name, description, parameters, handler(args) → {text, isError?} }
//   handler 可同步可异步；注册后可动态增删；AgentLoop 只通过 execute() 调用。
//   宿主可注入"默认执行器"（元枢注入 executeUnifiedTool 复用宪法红线等全部逻辑）。

export class ToolRegistry {
  constructor(options = {}) {
    this.id = options.id || "default";
    this.name = options.name || "默认工具注册表";
    this.version = "1.0.0";
    this._tools = new Map();
    this.defaultExecutor = options.defaultExecutor || null;
  }

  // 注册工具：def = { name, description, parameters?, handler }
  register(def) {
    if (!def || typeof def.name !== "string" || !def.name) throw new Error("工具必须提供 name");
    if (this._tools.has(def.name)) throw new Error(`工具 ${def.name} 已注册`);
    if (typeof def.handler !== "function" && !def.executor) throw new Error(`工具 ${def.name} 缺少 handler`);
    this._tools.set(def.name, def);
    return def.name;
  }

  unregister(name) {
    return this._tools.delete(name);
  }

  has(name) { return this._tools.has(name); }

  // 取内部定义（含 parallel 等调度标记）；调度器判排他屏障用
  getDef(name) { return this._tools.get(name) || null; }

  list() {
    return [...this._tools.values()].map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || { type: "object", properties: {} },
      },
    }));
  }

  // 工具名列表（简短形式，给前端/模型看）
  names() { return [...this._tools.keys()]; }

  // 执行工具：优先 handler，回退 defaultExecutor（宿主注入的现有执行链）
  async execute(name, args, opts = {}) {
    const def = this._tools.get(name);
    if (def) {
      try {
        if (def.executor) return await def.executor(args, opts);
        const out = await def.handler(args, opts);
        return normalizeToolOut(out);
      } catch (e) {
        return { text: `工具 ${name} 执行异常: ${String(e?.message || e).slice(0, 200)}`, isError: true };
      }
    }
    if (this.defaultExecutor) {
      try {
        const out = await this.defaultExecutor(name, args, opts);
        return normalizeToolOut(out);
      } catch (e) {
        return { text: `工具 ${name} 执行异常: ${String(e?.message || e).slice(0, 200)}`, isError: true };
      }
    }
    return { text: `未知工具: ${name}`, isError: true };
  }
}

function normalizeToolOut(out) {
  if (out == null) return { text: "(无输出)" };
  if (typeof out === "string") return { text: out };
  if (typeof out.text === "string") return out;
  return { text: JSON.stringify(out) };
}

// 注册为插件时的 mount 返回
export function createToolRegistryPlugin(registry) {
  return {
    id: `tool-registry:${registry.id}`,
    name: `工具注册表: ${registry.name}`,
    deps: [],
    mount: () => registry,
  };
}

export default ToolRegistry;
