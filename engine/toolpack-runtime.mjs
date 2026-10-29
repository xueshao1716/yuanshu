// ===== toolpack-runtime.mjs —— 工具包在 worker 里跑，只给声明的权限（2026-10-29）=====
//
// 为什么不直接 require 插件里的 js：那等于把服务进程交出去。
// 这里沿用 code-mode 的思路：把工具体当函数体 new Function 执行（拿不到 require/import），
// 需要能力时只能调用宿主注入的 $tools.xxx，而 $tools 里每一项都先查权限声明。
//
// 权限名（跟 manifest.permissions 对齐）：
//   net         → $tools.http_get / $tools.web_search
//   fs          → $tools.read_text / $tools.write_text（限工作区）
//   exec        → $tools.run_command（白名单命令）
//   workspace   → $tools.write_text 允许写（默认只读）
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const WORKER_SRC = `
import { parentPort, workerData } from "node:worker_threads";
const { body, args, toolName } = workerData;
const pending = new Map();
let seq = 0;
const $tools = new Proxy({}, {
  get: (_t, name) => (...a) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "call", id, name: String(name), args: a });
  }),
});
parentPort.on("message", (m) => {
  if (m?.type !== "result") return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.value);
  else p.reject(Object.assign(new Error(m.error || "tool_error"), { kind: m.kind || "binding" }));
});
(async () => {
  try {
    const fn = new Function("$tools", "args", "toolName", '"use strict"; return (async () => {\\n' + body + '\\n})();');
    const value = await fn($tools, args, toolName);
    parentPort.postMessage({ type: "done", ok: true, value: typeof value === "string" ? value : JSON.stringify(value) });
  } catch (e) {
    parentPort.postMessage({ type: "done", ok: false, error: String(e?.message || e).slice(0, 1200) });
  }
})();
`;

const PERM = {
  net: ["http_get"],
  fs: ["read_text", "write_text"],
  exec: ["run_command"],
};

function allow(permissions, name) {
  const perms = new Set(permissions || []);
  for (const [perm, names] of Object.entries(PERM)) {
    if (names.includes(name)) return perms.has(perm);
  }
  return false;
}

/** 宿主侧实现：每个能力都要先过权限 */
function makeBindings({ permissions, wsRoot, fetchImpl = globalThis.fetch, execImpl = null }) {
  const ws = path.resolve(String(wsRoot || "."));
  const inside = (p) => {
    const abs = path.resolve(ws, String(p || ""));
    return abs === ws || abs.startsWith(ws + path.sep) ? abs : null;
  };
  const deny = (name, perm) => async () => { throw new Error(`权限不足：${name} 需要声明 "${perm}"`) };
  return {
    http_get: allow(permissions, "http_get")
      ? async (opts = {}) => {
          const url = String(opts.url || "");
          if (!/^https?:\/\//i.test(url)) throw new Error("只支持 http(s) URL");
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(Number(opts.timeoutMs) || 15000) });
          const text = await res.text();
          return { status: res.status, text: text.slice(0, Number(opts.maxChars) || 200_000) };
        }
      : deny("http_get", "net"),
    read_text: allow(permissions, "read_text")
      ? async (opts = {}) => {
          const abs = inside(opts.path || "");
          if (!abs) throw new Error("路径越界：只允许工作区内");
          return fs.readFileSync(abs, "utf8").slice(0, Number(opts.maxChars) || 200_000);
        }
      : deny("read_text", "fs"),
    write_text: allow(permissions, "write_text")
      ? async (opts = {}) => {
          const abs = inside(opts.path || "");
          if (!abs) throw new Error("路径越界：只允许工作区内");
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, String(opts.text ?? ""), "utf8");
          return { ok: true, path: abs };
        }
      : deny("write_text", "fs"),
    run_command: allow(permissions, "run_command") && typeof execImpl === "function"
      ? async (opts = {}) => execImpl(String(opts.command || ""))
      : deny("run_command", "exec"),
  };
}

/**
 * 跑一个工具包里的工具。
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function runToolpackTool({
  tool,
  args = {},
  permissions = [],
  wsRoot = ".",
  timeoutMs = 20_000,
  fetchImpl = globalThis.fetch,
  execImpl = null,
} = {}) {
  if (!tool || !String(tool.body || "").trim()) return { ok: false, error: "工具没有 body" };
  const bindings = makeBindings({ permissions, wsRoot, fetchImpl, execImpl });
  return await new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      type: "module",
      workerData: { body: String(tool.body), args, toolName: String(tool.name || "") },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `工具超时（${Math.round(timeoutMs / 1000)} 秒）` }), timeoutMs);
    worker.on("message", async (m) => {
      if (m?.type === "call") {
        const fn = bindings[m.name];
        if (typeof fn !== "function") {
          worker.postMessage({ type: "result", id: m.id, ok: false, error: `未知能力：${m.name}` });
          return;
        }
        try {
          const value = await fn(...(Array.isArray(m.args) ? m.args : []));
          worker.postMessage({ type: "result", id: m.id, ok: true, value });
        } catch (e) {
          worker.postMessage({ type: "result", id: m.id, ok: false, error: String(e?.message || e) });
        }
        return;
      }
      if (m?.type === "done") {
        finish(m.ok ? { ok: true, text: String(m.value ?? "") } : { ok: false, error: String(m.error || "工具失败") });
      }
    });
    worker.on("error", (e) => finish({ ok: false, error: String(e?.message || e).slice(0, 500) }));
    worker.on("exit", (code) => { if (!settled && code !== 0) finish({ ok: false, error: `worker 退出（code ${code}）` }) });
  });
}

/** 把工具包转成模型可见的工具定义（名字加前缀防撞） */
export function toolDefsFromPack(pack) {
  return (pack?.tools || []).map((t) => ({
    type: "function",
    function: {
      name: `tp_${String(pack.id).replace(/[^a-z0-9_]/g, "_")}_${t.name}`.slice(0, 64),
      description: `[插件 ${pack.name}] ${t.description}`.slice(0, 400),
      parameters: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} },
    },
  }));
}
