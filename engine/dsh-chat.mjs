// engine/dsh-chat.mjs —— dsh 对话适配器（厂商主驾，一轮 headless）
// 不是 unifiedChat 套皮。dsh 仍是可卸适配器；元枢才是要长成的引擎。
import fs from "node:fs";
import { spawn } from "node:child_process";
import { extractStructuredOut, friendlyDshError, resolveDshEnv, resolveDshBin } from "./dsh-tool.mjs";
import { extractMessages } from "./session/utils.mjs";
import { readEntriesFromFile } from "./session/files.mjs";
import { createSseWriter } from "./sse.mjs";
import { saveArtifact } from "./workspace-api.mjs";
import { localizeMarkdownImagesDetailed } from "./media/markdown-images.mjs";
import { sdkSafeAssistantBlocks } from "./yuanshu-session.mjs";
import { beginYuanshuEmotion, endYuanshuEmotion } from "./yuanshu-emotion.mjs";
import { recordInteraction, judgeTurnKind } from "./relationship.mjs";

const HIST_TAIL = 8;
const BUBBLE = 800;

function clip(s, n = BUBBLE) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function buildDshPrompt(history, message, context = "") {
  const lines = [];
  const hist = Array.isArray(history) ? history.slice(-HIST_TAIL) : [];
  for (const m of hist) {
    const role = m?.role === "assistant" ? "助手" : "用户";
    const text = clip(m?.text || "");
    if (text) lines.push(`${role}：${text}`);
  }
  const recent = lines.length ? `【最近对话】\n${lines.join("\n")}\n\n` : "";
  // dsh 是独立单轮进程：主通道那种"往 history 里插 system 块"在这里不生效，
  // 开轮注入只能靠 prompt。这段语境由 beginYuanshuEmotion 生成（情绪/关系/人格/成长）。
  const injected = String(context || "").trim();
  const contextBlock = injected ? `【本轮语境】\n${injected}\n\n` : "";
  return [
    "你是小语，运行在元枢工作台。本轮由 dsh（DeepSeek Harness）主驾。",
    "用中文直接回答用户。不要输出派单用的 JSON 协议块，不要自称其他产品。",
    "",
    contextBlock + recent + `【本轮用户】\n${String(message || "").trim()}`,
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

// ══ 2026-11-10 P1-6：dsh 臂只接"最小一致面"，其余层**明确不接** ═══════════════
// 已接（语义与主通道一致）：
//   ① 落库走 sdkSafeAssistantBlocks —— pi SDK 原样重放 assistant.content 时，附件块会让
//      token 估算器抛 TypeError、整段会话从此不可重放（真机事故见 yuanshu-session.mjs 顶部）。
//      主通道一直走这条路，dsh 以前是裸 appendMessage，属于同一颗雷没排。
//   ② usage 事件 —— dsh headless 不回 token 用量，但"没有这个事件"和"用量为 0"是两件事：
//      用量/成本视角按事件计数，缺事件等于这一轮不存在。没有实测值就发 0/0 + estimated:true，
//      标的是"没测到"，不是"免费"；真实用量接进来之前不许伪装成实测值。
//   ③ 情绪与关系 —— 开轮 beginYuanshuEmotion（语境注入 prompt）、收尾 endYuanshuEmotion，
//      其后 recordInteraction + judgeTurnKind（与主通道同判据）。dsh 没有工具事件，
//      repeatedFailures 传 0：不拿假的失败数去推基因层。
// 不接（不是漏了，是证据来源不成立，硬接比不接更糟）：
//   · 基因 / 成长：靠"工具失败数 + 关系增量 + 对话节奏"推进；dsh 只有一轮文本、没有工具事件，
//     喂 0 失败会让这两层以为"每轮都很顺"，污染长期状态；
//   · 反模式：采样自工具名/参数/成败（主通道 onToolEnd），dsh 单进程 headless 拿不到；
//   · 复习：闭环是"注入即记账 + 看当轮是否照做"，dsh 没有可观测的后续动作；
//   · 正向账本：只认交付门回执（delivery_check）与写类工具碰过的路径，dsh 两者都没有。
// 等 dsh 能给出工具事件/交付回执，再逐个接。

function beginDshEmotionContext(sessionId, message, history) {
  try {
    const injected = beginYuanshuEmotion(sessionId || "new", message, Array.isArray(history) ? history : [], { turnId: crypto.randomUUID() });
    // 返回 [system, ...history] 才说明本轮有新语境；没插块就什么都不加。
    if (Array.isArray(injected) && injected.length > (history?.length || 0) && injected[0]?.role === "system") {
      return String(injected[0].content || "").trim();
    }
  } catch {}
  return "";
}

function finishDshEmotion(sessionId, message, text, writer) {
  try { endYuanshuEmotion(sessionId || "new", message, text, writer); } catch {}
}

function recordDshInteraction(sessionId, message) {
  try {
    if (/^eval-/.test(String(sessionId || ""))) return;   // 评测会话不写关系（与主通道一致）
    const verdict = judgeTurnKind({ userText: message, repeatedFailures: 0 });
    recordInteraction({ kind: verdict.kind, note: verdict.note || (verdict.kind === "negative" ? verdict.reason : "") });
  } catch {}
}

function pushDshUsage(writer) {
  try {
    writer.push("usage", {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
      prompt: 0, completion: 0,
      estimated: true, engine: "dsh",
    });
  } catch {}
}

export async function handleDshChat(res, entry, message, sessionId, signal, opts = {}) {
  const writer = opts.writer || createSseWriter(res);
  const run = opts.runTurn || runDshTurn;
  const history = opts.history || loadHistory(entry);
  const key = sessionId || "new";
  writer.push("note", { text: "dsh 冷启动约 5-20s…" });
  // 开轮注入必须在 run 之前取（它会推进情绪/关系快照，跑完再取就是"下一轮"的语境）。
  const emotionContext = beginDshEmotionContext(key, message, history);
  const result = await run({
    task: buildDshPrompt(history, message, emotionContext),
    cwd: opts.cwd,
    signal,
    bin: opts.bin,
    env: opts.env,
    spawnFn: opts.spawnFn,
  });
  if (signal?.aborted || result?.aborted) {
    // 中途停掉也是一轮的收尾：情绪要落，否则她会停在"这句话没说完"的状态里。
    finishDshEmotion(key, message, "（本轮已停止）", writer);
    return { aborted: true };
  }
  if (!result?.ok) {
    writer.push("error", { message: result?.error || "dsh 未返回内容" });
    return result;
  }
  const rawText = finishDshText(result.text);
  if (!rawText) {
    writer.push("error", { message: "dsh 未返回内容" });
    return { ...result, ok: false };
  }
  // 正文外链图先归档：落库/广播都只发本地地址（失败/超限只留一行文字）。
  const text = (await localizeMarkdownImagesDetailed(rawText, { wsRoot: opts.cwd || "", saveArtifact })).text;
  // ① 与主通道同一条落库路径：附件块一律改写成纯文本 markdown，会话才可重放。
  const blocks = sdkSafeAssistantBlocks([{ type: "text", text }]);
  try {
    entry?.sm?.appendMessage({ role: "user", content: [{ type: "text", text: message }] });
    entry?.sm?.appendMessage({ role: "assistant", content: blocks });
    if (entry?.sm && !entry.sm.getSessionName?.()) {
      try { entry.sm.appendSessionInfo(String(message).slice(0, 24)); } catch {}
    }
  } catch {}
  writer.push("delta", { text });
  pushDshUsage(writer);
  // ③ 收尾：先情绪（会推 emotion 事件给前端），再关系记账。顺序与主通道一致。
  finishDshEmotion(key, message, text, writer);
  recordDshInteraction(key, message);
  writer.push("done", { sessionId, engine: "dsh" });
  return { ok: true, text };
}
