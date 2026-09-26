// ===== sandbox-session.mjs —— 会话级沙箱模式（借 dsh-sandbox-policy / permission-presets）=====
//
// 元枢原本的沙箱模式是**写死的**：`unified-chat.mjs` 里
// `sandboxMode: isPlanLock ? "read-only" : "workspace-write"`，前端没有任何控件，
// config 里也没有开关。于是：
//   · 想让整个会话只看不改（read-only）——做不到
//   · 想整会话放开到工作区外——做不到（只能在单次调用里带 sandbox_permissions + justification）
//   · 模式什么时候变过——没有记录
//
// dsh 的做法是"**会话事件即状态，投影出有效值**"（dsh-sandbox-policy:41-43,114-120）：
// 切换只 append 一条 `sandbox/mode` 事件，有效模式由 fold 日志得出。这里等价实现成
// 一条 append-only 的 JSONL，最新一条生效——模式的每次变化都可审计、可回放。
//
// 两条来自 dsh 的规矩：
//   · **收紧随时可以，放宽必须给理由**。dsh 的单次升级必须配 justification
//     （`yuanshu-sandbox.mjs:55`）；会话级放宽同理——没有理由的放宽，在日志里就是
//     一句无据可查的授权。
//   · **切换的是具名预设，不是一个裸值**（dsh-permission-presets）。预设自带 label 与
//     说明，界面上不会出现"只改了模式、没人知道这意味着什么"的半吊子状态。
//
// 关于默认值——**这里刻意与 dsh 不同**。dsh 的部署默认是 read-only（最严）；元枢保持
// standard（workspace-write，中档），理由是三条实测得出的：
//   ① 元枢的沙箱阶梯**只管 yuanshu 这条路**（`gateSandboxCall` 全仓只在
//      `yuanshu-loop.mjs:117` 被调用）；默认主驾的 pi 路径用的是 Pi SDK 自己的工具，
//      不经这道阶梯。把默认收成 read-only，收紧的是一条非默认路径。
//   ② read-only 下写操作会转成审批请求，无人值守时按 fail-closed 拒绝——元枢的常态是
//      跑长任务，那会让任务在第一次写就停住。
//   ③ workspace-write 本身已经不是"宽松那端"：它禁止工作区外的路径，危险命令
//      （`BASH_DANGER_RE`）仍需单独升级。
// 要改成最严，只改 `DEFAULT_PRESET` 一行即可；改动会体现在下面的注释与测试里。
import fs from "node:fs";
import path from "node:path";
import { SANDBOX_MODES, sandboxRank } from "./yuanshu-sandbox.mjs";

/** 具名预设。approval 姿态元枢只有一种（单次授权、没有"总是允许"），所以这里不假装有开关。 */
export const SANDBOX_PRESETS = {
  cautious: {
    mode: "read-only",
    label: "只看不改",
    desc: "任何写文件 / 跑命令都要你当场批准。适合让它读代码、做分析、出方案。",
  },
  standard: {
    mode: "workspace-write",
    label: "标准",
    desc: "可以写工作区内的文件；危险命令与工作区外的路径仍需批准。（默认）",
  },
  trusted: {
    mode: "danger-full-access",
    label: "放开",
    desc: "允许动工作区外。单次升级仍需你批准，模式变化会记进审计日志。",
  },
};

/** 默认预设。改这一行就等于改默认沙箱方向——改之前请读文件头的三条理由。 */
export const DEFAULT_PRESET = "standard";

export function sandboxSessionPaths(agentDir = "") {
  const dir = path.join(agentDir || ".", "yuanshu-sandbox");
  return { dir, log: path.join(dir, "sandbox-modes.jsonl") };
}

export function readSandboxLog(agentDir, { fsMod = fs, limit = 0 } = {}) {
  try {
    const raw = fsMod.readFileSync(sandboxSessionPaths(agentDir).log, "utf8");
    const rows = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try { const e = JSON.parse(s); if (e && e.sessionId && e.preset) rows.push(e); } catch { /* 坏行跳过，不丢整份日志 */ }
    }
    return limit > 0 ? rows.slice(-limit) : rows;
  } catch { return []; }
}

/**
 * 记一次模式切换。append-only，最新一条生效。
 * @returns {{ok:boolean, entry?:object, reason?:string}}
 */
export function recordSandboxMode(agentDir, sessionId, { preset, origin = "human", reason = "" } = {}, { fsMod = fs, now } = {}) {
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: false, reason: "缺少 sessionId" };
  const next = SANDBOX_PRESETS[preset];
  if (!next) return { ok: false, reason: `未知预设：${preset}（可用：${Object.keys(SANDBOX_PRESETS).join(" / ")}）` };
  const current = effectiveSandboxPreset(agentDir, sid, { fsMod });
  const widening = sandboxRank(next.mode) > sandboxRank(current.mode);
  // 规矩：收紧随时可以，放宽必须给理由
  if (widening && !String(reason || "").trim()) {
    return { ok: false, reason: `从 ${current.mode} 放宽到 ${next.mode} 必须写明理由（审计要能回答"谁为什么放开"）` };
  }
  const entry = {
    sessionId: sid,
    preset,
    mode: next.mode,
    from: current.preset,
    widening,
    origin: origin === "human" ? "human" : origin === "api" ? "api" : "model",
    reason: String(reason || "").trim().slice(0, 200) || null,
    at: (now instanceof Date ? now : new Date()).toISOString(),
  };
  try {
    fsMod.mkdirSync(sandboxSessionPaths(agentDir).dir, { recursive: true });
    fsMod.appendFileSync(sandboxSessionPaths(agentDir).log, JSON.stringify(entry) + "\n");
    return { ok: true, entry };
  } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 80) }; }
}

/** fold：该会话最后一条记录生效；没有记录就是默认预设。 */
export function effectiveSandboxPreset(agentDir, sessionId, { fsMod = fs } = {}) {
  const sid = String(sessionId || "").trim();
  const rows = readSandboxLog(agentDir, { fsMod }).filter((e) => e.sessionId === sid);
  const last = rows[rows.length - 1];
  const key = last && SANDBOX_PRESETS[last.preset] ? last.preset : DEFAULT_PRESET;
  return { preset: key, ...SANDBOX_PRESETS[key] };
}

/** 有效沙箱模式。planLock 时强制 read-only——计划模式只能比会话更严，不能更宽。 */
export function effectiveSandboxMode(agentDir, sessionId, { fsMod = fs, planLock = false } = {}) {
  if (planLock) return "read-only";
  const mode = effectiveSandboxPreset(agentDir, sessionId, { fsMod }).mode;
  return SANDBOX_MODES.includes(mode) ? mode : SANDBOX_PRESETS[DEFAULT_PRESET].mode;
}

/** 台前用：这个会话的模式变化史 + 可用预设。 */
export function sandboxModeView(agentDir, sessionId, { fsMod = fs, limit = 20 } = {}) {
  const eff = effectiveSandboxPreset(agentDir, sessionId, { fsMod });
  const history = readSandboxLog(agentDir, { fsMod }).filter((e) => e.sessionId === String(sessionId || "").trim()).slice(-limit).reverse();
  return {
    preset: eff.preset,
    mode: eff.mode,
    label: eff.label,
    desc: eff.desc,
    defaultPreset: DEFAULT_PRESET,
    presets: Object.entries(SANDBOX_PRESETS).map(([id, p]) => ({ id, ...p })),
    history: history.map(({ at, preset, mode, from, widening, origin, reason }) => ({ at, preset, mode, from, widening, origin, reason })),
  };
}
