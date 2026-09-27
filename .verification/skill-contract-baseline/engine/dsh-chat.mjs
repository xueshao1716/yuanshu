// engine/dsh-chat.mjs —— dsh 对话适配器（厂商主驾，一轮 headless）
// 不是 unifiedChat 套皮。dsh 仍是可卸适配器；元枢才是要长成的引擎。
import fs from "node:fs";
import { spawn } from "node:child_process";
import { extractStructuredOut, friendlyDshError, resolveDshEnv, resolveDshBin } from "./dsh-tool.mjs";
import { extractMessages } from "./session-utils.mjs";
import { readEntriesFromFile } from "./session-files.mjs";
import { createSseWriter } from "./sse.mjs";

const HIST_TAIL = 8;
const BUBBLE = 800;

function clip(s, n = BUBBLE) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function buildDshPrompt(history, message) {
  const lines = [];
  const hist = Array.isArray(history) ? history.slice(-HIST_TAIL) : [];
  for (const m of hist) {
    const role = m?.role === "assistant" ? "助手" : "用户";
    const text = clip(m?.text || "");
    if (text) lines.push(`${role}：${text}`);
  }
  const recent = lines.length ? `【最近对话】\n${lines.join("\n")}\n\n` : "";
  return [
    "你是小语，运行在元枢工作台。本轮由 dsh（DeepSeek Harness）主驾。",
    "用中文直接回答用户。不要输出派单用的 JSON 协议块，不要自称其他产品。",
    "",
    recent + `【本轮用户】\n${String(message || "").trim()}`,
  ].join("\n");
}

export function finishDshText(raw) {
  const parsed = extractStructuredOut(raw);
  if (parsed.ok && parsed.data?.result) return String(parsed.data.result).trim();
  return String(raw || "").trim();
}

function spawnArgs(bin, task) {
  const isJs = String(bin).endsWith(".js");
  if (isJs) return { cmd: process.execPath, args: [bin, "--profile", "headless", task] };
  return { cmd: bin, args: ["--profile", "headless", task] };
}

export function runDshTurn({
  task,
  cwd,
  env,
  bin,
  spawnFn,
  signal,
  timeoutMs = 180000,
  onChunk,
} = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, aborted: true, text: "", error: "aborted" });
    const exe = bin || resolveDshBin();
    const { cmd, args } = spawnArgs(exe, String(task || ""));
    const spawnImpl = spawnFn || spawn;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child = null;
    let timer = null;
    const onAbort = () => {
      try { child?.kill("SIGTERM"); } catch {}
      finish({ ok: false, aborted: true, text: stdout, error: "aborted" });
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { signal?.removeEventListener("abort", onAbort); } catch {}
      resolve(result);
    };
    try {
      child = spawnImpl(cmd, args, { cwd, windowsHide: true, env: env || resolveDshEnv() });
    } catch (e) {
      return finish({ ok: false, aborted: false, text: "", error: String(e?.message || e) });
    }
    timer = setTimeout(() => {
      try { child?.kill("SIGTERM"); } catch {}
      finish({ ok: false, aborted: false, text: stdout, error: friendlyDshError("timeout", stderr) });
    }, timeoutMs);
    try { signal?.addEventListener("abort", onAbort, { once: true }); } catch {}
    child.stdout?.on("data", (buf) => {
      const t = String(buf);
      stdout += t;
      if (onChunk) onChunk(t);
    });
    child.stderr?.on("data", (buf) => { stderr += String(buf); });
    child.on("error", (e) => {
      finish({ ok: false, aborted: false, text: stdout, error: friendlyDshError(e?.message, stderr) });
    });
    child.on("close", (code) => {
      if (signal?.aborted) return finish({ ok: false, aborted: true, text: stdout, error: "aborted" });
      const text = stdout.trim();
      const ok = code === 0 && !!text;
      finish({
        ok,
        aborted: false,
        text,
        error: ok ? "" : friendlyDshError(code ? `exit ${code}` : "", stderr),
      });
    });
  });
}

function loadHistory(entry) {
  try {
    const file = entry?.sm?.sessionFile;
    if (file && fs.existsSync(file)) return extractMessages(readEntriesFromFile(file)).slice(-HIST_TAIL);
  } catch {}
  return [];
}

export async function handleDshChat(res, entry, message, sessionId, signal, opts = {}) {
  const writer = opts.writer || createSseWriter(res);
  const run = opts.runTurn || runDshTurn;
  const history = opts.history || loadHistory(entry);
  writer.push("note", { text: "dsh 冷启动约 5-20s…" });
  const result = await run({
    task: buildDshPrompt(history, message),
    cwd: opts.cwd,
    signal,
    bin: opts.bin,
    env: opts.env,
    spawnFn: opts.spawnFn,
  });
  if (signal?.aborted || result?.aborted) return { aborted: true };
  if (!result?.ok) {
    writer.push("error", { message: result?.error || "dsh 未返回内容" });
    return result;
  }
  const text = finishDshText(result.text);
  if (!text) {
    writer.push("error", { message: "dsh 未返回内容" });
    return { ...result, ok: false };
  }
  try {
    entry?.sm?.appendMessage({ role: "user", content: [{ type: "text", text: message }] });
    entry?.sm?.appendMessage({ role: "assistant", content: [{ type: "text", text }] });
    if (entry?.sm && !entry.sm.getSessionName?.()) {
      try { entry.sm.appendSessionInfo(String(message).slice(0, 24)); } catch {}
    }
  } catch {}
  writer.push("delta", { text });
  writer.push("done", { sessionId, engine: "dsh" });
  return { ok: true, text };
}
