import fs from "node:fs";
import path from "node:path";
// ===== session-store.mjs —— Gateway 2.0 会话存储（dsh SessionStore 思想沉淀）=====
// 设计：SessionStore 接口 = { save, load, list, delete }
//   内置两种实现：MemorySessionStore（内存，重启即失）、FileSessionStore（JSON 文件持久化）。
//   AgentLoop/Gateway 只认接口，换实现不改业务代码。

export class MemorySessionStore {
  constructor(options = {}) {
    this.id = options.id || "memory";
    this.name = options.name || "内存会话存储";
    this.version = "1.0.0";
    this._data = new Map();
  }

  async save(session) {
    if (!session || !session.id) throw new Error("会话必须有 id");
    this._data.set(session.id, structuredClone(session));
    return session.id;
  }

  async load(id) {
    const s = this._data.get(id);
    return s ? structuredClone(s) : null;
  }

  async list() {
    return [...this._data.values()].map((s) => ({ id: s.id, title: s.title || s.id, updatedAt: s.updatedAt }));
  }

  async delete(id) { return this._data.delete(id); }
}

export class FileSessionStore {
  constructor(options = {}) {
    this.id = options.id || "file";
    this.name = options.name || "文件会话存储";
    this.version = "1.0.0";
    this.dir = options.dir; // 会话目录（必须提供）
    this.fs = options.fs || fs;
    this.path = options.path || path;
  }

  _file(id) { return this.path.join(this.dir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`); }

  async save(session) {
    if (!session || !session.id) throw new Error("会话必须有 id");
    this.fs.mkdirSync(this.dir, { recursive: true });
    // 原子写（08-25）：崩溃/并发不再留半截 JSON
    const target = this._file(session.id);
    const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
    this.fs.writeFileSync(tmp, JSON.stringify(session, null, 2), "utf8");
    try { this.fs.renameSync(tmp, target); }
    catch (e) { try { this.fs.unlinkSync(tmp); } catch {} throw e; }
    return session.id;
  }

  async load(id) {
    try {
      return JSON.parse(this.fs.readFileSync(this._file(id), "utf8"));
    } catch { return null; }
  }

  async list() {
    if (!this.fs.existsSync(this.dir)) return [];
    return this.fs.readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const s = JSON.parse(this.fs.readFileSync(this.path.join(this.dir, f), "utf8"));
          return { id: s.id || f.replace(/\.json$/, ""), title: s.title || s.id || f, updatedAt: s.updatedAt };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async delete(id) {
    try { this.fs.unlinkSync(this._file(id)); return true; } catch { return false; }
  }
}

// 注册为插件时的 mount 返回
export function createSessionStorePlugin(store) {
  return {
    id: `session-store:${store.id}`,
    name: `会话存储: ${store.name}`,
    deps: [],
    mount: () => store,
  };
}

export default MemorySessionStore;
