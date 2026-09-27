// ===== plugin-registry.mjs —— Gateway 2.0 插件注册表（dsh 插件化思想沉淀）=====
// 设计：每个插件 = { id, name, version, deps, mount(ctx), unmount(ctx) }
//   mount 返回该插件提供的服务（对象/函数）；unmount 负责清理。
//   依赖按注册顺序自动拓扑排序，卸载时逆序回收。
// 用法：
//   registry.register({ id: "model-adapter", deps: [], mount: (ctx) => ({...}) })
//   registry.get("model-adapter")   // 拿到服务
//   registry.unregister("model-adapter")

class PluginError extends Error {
  constructor(message, code = "PLUGIN_ERROR") {
    super(message);
    this.code = code;
  }
}

export class PluginRegistry {
  constructor(options = {}) {
    this.options = options;
    this._plugins = new Map();   // id -> { def, instance, order }
    this._services = new Map();  // id -> mount 返回值
    this._ctx = { registry: this, ...options.ctx };
  }

  // ── 注册 ──
  // def: { id, name?, version?, deps?: string[], mount(ctx), unmount?(instance, ctx) }
  register(def) {
    if (!def || typeof def.id !== "string" || !def.id) throw new PluginError("插件必须提供 id", "PLUGIN_NO_ID");
    if (this._plugins.has(def.id)) throw new PluginError(`插件 ${def.id} 已注册`, "PLUGIN_EXISTS");
    if (typeof def.mount !== "function") throw new PluginError(`插件 ${def.id} 缺少 mount 函数`, "PLUGIN_NO_MOUNT");
    const deps = Array.isArray(def.deps) ? def.deps : [];
    for (const d of deps) {
      if (!this._plugins.has(d) && !this._services.has(d)) {
        throw new PluginError(`插件 ${def.id} 依赖 ${d} 未注册`, "PLUGIN_MISSING_DEP");
      }
    }
    const order = this._nextOrder(def, deps);
    const entry = { def, instance: null, order };
    this._plugins.set(def.id, entry);
    this._reorder();
    return def.id;
  }

  // 计算注册顺序：必须在所有依赖之后
  _nextOrder(def, deps) {
    let max = 0;
    for (const d of deps) {
      const dep = this._plugins.get(d);
      if (dep && dep.order >= max) max = dep.order + 1;
    }
    // 已挂载的依赖（注册表外提供的服务）视为顺序 0
    return Math.max(max, this._plugins.size);
  }

  _reorder() {
    // 稳定拓扑：按 order 升序，同 order 保持插入序
    const arr = [...this._plugins.entries()].sort((a, b) => a[1].order - b[1].order);
    arr.forEach(([, v], i) => { v.order = i; });
  }

  // ── 挂载全部（按依赖顺序）──
  async mountAll() {
    const sorted = this._sorted();
    for (const { def } of sorted) {
      if (this._services.has(def.id)) continue;
      await this._mountOne(def);
    }
    return this._services;
  }

  async _mountOne(def) {
    try {
      const instance = await def.mount(this._ctx);
      this._services.set(def.id, instance);
      this._plugins.get(def.id).instance = instance;
      return instance;
    } catch (e) {
      throw new PluginError(`插件 ${def.id} 挂载失败: ${String(e?.message || e)}`, "PLUGIN_MOUNT_FAIL");
    }
  }

  // ── 卸载 ──
  async unregister(id) {
    const entry = this._plugins.get(id);
    if (!entry) return false;
    // 先卸载依赖它的插件（逆序）
    for (const [depId, dep] of this._plugins) {
      if (depId === id) continue;
      if ((dep.def.deps || []).includes(id)) await this.unregister(depId);
    }
    try {
      if (typeof entry.def.unmount === "function") await entry.def.unmount(entry.instance, this._ctx);
    } finally {
      this._plugins.delete(id);
      this._services.delete(id);
    }
    this._reorder();
    return true;
  }

  // ── 查询 ──
  get(id) { return this._services.get(id); }
  has(id) { return this._plugins.has(id); }
  list() {
    return this._sorted().map(({ def, instance }) => ({
      id: def.id,
      name: def.name || def.id,
      version: def.version,
      deps: def.deps || [],
      mounted: !!instance,
    }));
  }

  _sorted() {
    return [...this._plugins.values()].sort((a, b) => a.order - b.order);
  }

  // 便捷：注册并挂载单个插件（测试/动态添加用）
  async load(def) {
    this.register(def);
    await this._mountOne(def);
    return this.get(def.id);
  }

  // 便捷：卸载并清理全部
  async dispose() {
    const ids = this._sorted().map(({ def }) => def.id).reverse();
    for (const id of ids) await this.unregister(id);
  }
}

export default PluginRegistry;
