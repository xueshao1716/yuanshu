// ===== code-worker.mjs —— CodeRuntime 的执行后端（worker_threads 隔离）=====
// 模型写的程序在这个 worker 里执行：
//   - 只能通过 $tools.<name>(...) 操作宿主能力（绑定由宿主注入执行器）
//   - 无法 import/require（new Function 语法限制），天然隔离宿主模块
//   - console.* 被劫持收集为 logs；顶层 await/return 可用
// 协议：worker → host: { type:"call", id, name, args }（请求执行绑定）
//       host → worker: { type:"call-result", id, ok, value|error }

import { parentPort, workerData } from "node:worker_threads";

const { program, bindingNames, maxLogs = 500 } = workerData || {};

// ── 绑定代理：$tools.xxx(...) → postMessage 请求宿主执行 ──
const pending = new Map();
let callId = 0;

const $tools = {};
for (const name of bindingNames || []) {
  $tools[name] = (...args) =>
    new Promise((resolve, reject) => {
      const id = ++callId;
      pending.set(id, { resolve, reject });
      parentPort.postMessage({ type: "call", id, name, args });
    });
}

// ── 日志捕获（限制条数防溢出）──
const logs = [];
let logFull = false;
function fmtArg(x) {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}
function pushLog(level, args) {
  if (logFull) return;
  const line = `[${level}] ${Array.from(args).map(fmtArg).join(" ")}`;
  logs.push(line);
  if (logs.length >= maxLogs) { logFull = true; logs.push(`[log] （日志已达 ${maxLogs} 条上限，停止收集）`); }
}

globalThis.$tools = $tools;
globalThis.console = {
  log: (...a) => pushLog("log", a),
  info: (...a) => pushLog("info", a),
  warn: (...a) => pushLog("warn", a),
  error: (...a) => pushLog("error", a),
  debug: (...a) => pushLog("debug", a),
};

parentPort.on("message", (msg) => {
  if (msg?.type !== "call-result") return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve({ text: msg.value, isError: false });
  else p.reject(Object.assign(new Error(msg.value), { kind: "binding" }));
});

function safeSerialize(value) {
  try {
    const v = structuredClone(value);
    return v;
  } catch {
    try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
  }
}

(async () => {
  let value, error = null;
  try {
    // 程序作为 async 函数体执行：顶层 await / return 可用
    const fn = new Function(`"use strict"; return (async () => {\n${program}\n})();`);
    value = await fn();
  } catch (e) {
    let message = String(e?.message || e).slice(0, 2000);
    // 2026-10-29：这两类错误信息本身没给下一步，补一句能用什么
    if (/require is not defined|Cannot use import statement|import\s+.*from/i.test(message)) {
      message += `\n\n（沙箱里没有 require/import：文件请用 $tools.read_file / $tools.write_file，命令请用 $tools.run_command；可用绑定：${(bindingNames || []).join(", ") || "无"}）`;
    }
    error = { kind: e?.kind || "runtime", message };
  }
  try {
    parentPort.postMessage({ type: "done", value: safeSerialize(value), logs, error });
  } catch (e) {
    parentPort.postMessage({ type: "done", value: undefined, logs, error: { kind: "runtime", message: "结果序列化失败: " + String(e) } });
  }
})();
