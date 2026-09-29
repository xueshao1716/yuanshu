// pi-compat-fallback.mjs —— pi SDK 缺失时的最小宿主兼容层。
// 目标是让元枢统一引擎继续启动、建会话和落盘；Pi 专属 agent 路径会由上层明确禁用。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function id() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function readEntries(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function treeFromEntries(entries) {
  const roots = [];
  const byId = new Map();
  for (const entry of entries) {
    const node = { entry, children: [] };
    byId.set(entry.id, node);
    const parent = entry.parentId && byId.get(entry.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function defaultFallbackAgentDir() {
  const configured = String(process.env.YUANSHU_AGENT_DIR || process.env.PI_WEB_AGENT_DIR || "").trim();
  return configured || path.join(os.homedir(), ".pi", "agent");
}

export function createPiCompatFallback({ agentDir = defaultFallbackAgentDir() } = {}) {
  fs.mkdirSync(agentDir, { recursive: true });

  class FallbackSessionManager {
    constructor(cwd, sessionsDir, file = "") {
      this.cwd = cwd;
      this.sessionsDir = sessionsDir;
      fs.mkdirSync(sessionsDir, { recursive: true });
      this.sessionFile = file || path.join(sessionsDir, `${id()}.jsonl`);
      this.sessionId = path.basename(this.sessionFile, path.extname(this.sessionFile));
      if (!fs.existsSync(this.sessionFile)) {
        const header = { type: 'session', version: 3, id: this.sessionId, timestamp: new Date().toISOString(), cwd };
        fs.writeFileSync(this.sessionFile, file ? '' : JSON.stringify(header) + '\n', { encoding: 'utf8', flag: 'wx' });
      }
      const header = readEntries(this.sessionFile)[0];
      if (header?.type === 'session' && typeof header.id === 'string' && header.id.trim()
          && typeof header.cwd === 'string' && path.isAbsolute(header.cwd)) {
        this.sessionId = header.id;
        this.cwd = header.cwd;
      }
      this.sessionName = "";
    }
    static create(cwd, sessionsDir) { return new FallbackSessionManager(cwd, sessionsDir); }
    static open(file, sessionsDir, cwd) { return new FallbackSessionManager(cwd, sessionsDir, file); }
    getCwd() { return this.cwd; }
    getSessionId() { return this.sessionId; }
    getSessionFile() { return this.sessionFile; }
    getSessionName() {
      if (this.sessionName) return this.sessionName;
      const info = readEntries(this.sessionFile).find((e) => e.type === "session_info");
      return this.sessionName = String(info?.name || "");
    }
    appendSessionInfo(name) {
      this.sessionName = String(name || "").slice(0, 120);
      const entry = { type: "session_info", id: id(), timestamp: new Date().toISOString(), name: this.sessionName };
      fs.appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
    }
    appendMessage(message) {
      const entries = readEntries(this.sessionFile);
      const parentId = [...entries].reverse().find((e) => e.type === "message")?.id || "";
      const entry = { type: "message", id: id(), parentId, timestamp: new Date().toISOString(), message };
      fs.appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
      return entry;
    }
    appendCustomEntry(customType, data) {
      const entries = readEntries(this.sessionFile);
      const entry = { type: 'custom', customType, data, id: id(), parentId: entries.at(-1)?.id || null, timestamp: new Date().toISOString() };
      fs.appendFileSync(this.sessionFile, JSON.stringify(entry) + String.fromCharCode(10), 'utf8');
      return entry.id;
    }
    getTree() { return treeFromEntries(readEntries(this.sessionFile).filter(entry => entry.type !== 'session')); }
    getFileEntries() { return readEntries(this.sessionFile); }
  }

  class FallbackModelRuntime {
    static async create() { return new FallbackModelRuntime(); }
    getModels() { return []; }
    registerProvider() { return undefined; }
  }

  class FallbackDefaultResourceLoader {
    constructor({ cwd = "", agentDir: dir = agentDir } = {}) { this.cwd = cwd; this.agentDir = dir; }
    async reload() { return this; }
    getSkills() { return { skills: [], diagnostics: [{ level: "info", message: "pi SDK 未安装，跳过 SDK 技能扫描；元枢技能仍可直接加载。" }] }; }
  }

  class FallbackSettingsManager {
    static create(cwd, dir) { return { cwd, agentDir: dir, get: () => undefined, set: () => undefined }; }
  }

  async function unavailable() {
    throw new Error("pi SDK 不可用；当前请求应由元枢统一引擎承接");
  }

  return {
    createAgentSession: unavailable,
    createAgentSessionServices: unavailable,
    createAgentSessionFromServices: unavailable,
    SettingsManager: FallbackSettingsManager,
    ModelRuntime: FallbackModelRuntime,
    SessionManager: FallbackSessionManager,
    DefaultResourceLoader: FallbackDefaultResourceLoader,
    getAgentDir: () => agentDir,
    withFileMutationQueue: null,
  };
}
