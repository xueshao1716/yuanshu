// engine/engine-pair.mjs —— 主次引擎对（后台持久化，下一条消息生效）
// 元枢是自己的引擎胚子；pi / dsh 是可替换适配器，不是永久双核。
import fs from "node:fs";
import { atomicWriteJson } from "./atomic-io.mjs";
import { runYuanshuEval } from "./yuanshu-eval.mjs";

export const ENGINE_CATALOG = {
  yuanshu: {
    id: "yuanshu",
    label: "元枢",
    canLead: true,
    desc: "元枢自制执行引擎",
    intro: "元枢自制循环，承接对话、工具、记忆与媒体任务。主驾可配置，非原生通道由元枢执行；每轮消息显示实际执行引擎。",
    can: ["OpenAI 兼容与 Anthropic Messages 通道（以通道配置和实测能力为准）", "工具调度：只读可并行、写互斥", "上下文命名区段 + 沙箱阶梯 + 压缩留底", "prompt 区段接缝（插件贡献，一轮只收一次）", "磁盘工作记忆 task_plan/findings/progress", "后台任务与页面连接分离，重连后恢复已记录进度", "执行检查点与副作用记录，支持受控接续", "VAD 情绪自己开轮注入、收轮推 SSE，不靠外置适配器"],
    cannot: ["本地评测分数不等于真实模型的内容质量验收", "结果未知的工具操作不会自动重放，服务重启后部分任务仍需人工处理", "媒体精确像素受上游通道限制，天团自动复核不能代替人工验收"],
  },
  pi: {
    id: "pi",
    label: "兼容适配器",
    canLead: true,
    desc: "外置 Agent 兼容管线",
    intro: "外置 Agent 兼容管线，负责成熟的会话与工具生命周期；元枢保留它作为可替换的安全后备。",
    can: ["原生通道上的完整 Agent 生命周期", "会话文件与成熟工具链", "失败时兑底到次引擎（默认元枢）"],
    cannot: ["非原生通道会兑底元枢，不能硬开不兼容通道", "记忆、出图、规划由元枢外壳结算，不在这条适配器内部实现", "外置适配器，可卸，不是元枢本体"],
  },
  dsh: {
    id: "dsh",
    label: "dsh",
    // 2026-09-14 定为不可主驾。原先这里是 true，依据是测试里那句"对话适配器写完后应能主驾"
    // ——那是**完成度**目标，不是能力判断。实测元枢调用它的方式（每轮新起 headless 子进程、
    // 只回收 stdout、历史压成 8×800 字纯文本）：预热后稳定约 4.7s/轮，冷启动（包未进文件
    // 缓存）约 27s；且无流式、无记忆/情绪/出图/工具轨迹。前端早就有"（暂不能主驾）"这个状态。
    // 它真正的活是执行臂 dsh_task（can 列表那三条），与 canLead 无关。
    canLead: false,
    desc: "DeepSeek Harness 对话适配器（厂商，可卸）",
    intro: "DeepSeek Harness 的一轮 headless 适配器，兼执行臂。不是第二套自制循环。",
    can: ["派一次自包含 headless 任务（代码 / 沙箱 / 多步工作流），即 dsh_task 执行臂", "客户端断开可杀掉 dsh 子进程", "厂商可卸，不影响元枢自身循环"],
    cannot: ["不适合当主驾：每轮要新起 headless 子进程（实测预热约 4.7s/轮、冷启动约 27s）且无流式，历史只能压成近 8 条 × 800 字的纯文本摘要", "不是完整多轮大脑，不接记忆 / 出图 / 规划主循环", "依赖本机 dsh 安装和 DeepSeek 额度；厂商可卸，不能冒充元枢"],
  },
};

export const DEFAULT_PAIR = { primary: "pi", secondary: "yuanshu" };

let _file = "";

export function initEnginePair(file) {
  _file = file || "";
}

export function normalizePair(obj) {
  const primary = String(obj?.primary || DEFAULT_PAIR.primary);
  const secondary = String(obj?.secondary || DEFAULT_PAIR.secondary);
  if (!ENGINE_CATALOG[primary] || !ENGINE_CATALOG[secondary]) throw new Error("未知引擎");
  if (primary === secondary) throw new Error("主次不能相同");
  return { primary, secondary };
}

export function loadEnginePair() {
  try {
    if (_file && fs.existsSync(_file)) {
      return normalizePair(JSON.parse(fs.readFileSync(_file, "utf8")));
    }
  } catch {}
  return { ...DEFAULT_PAIR };
}

export function saveEnginePair(obj) {
  const pair = normalizePair(obj);
  if (_file) {
    try { atomicWriteJson(_file, pair); } catch {}
  }
  return pair;
}

export function swapEnginePair() {
  const cur = loadEnginePair();
  return saveEnginePair({ primary: cur.secondary, secondary: cur.primary });
}

export function resolveLead(pair, ctx = {}) {
  const p = (() => {
    try { return normalizePair(pair); } catch { return { ...DEFAULT_PAIR }; }
  })();
  if (ctx.forceYuanshu) {
    return { lead: "yuanshu", wanted: p.primary, deferred: p.primary === "yuanshu" ? null : p.primary, reason: "force" };
  }
  // 外置 Pi 适配器是可卸依赖。缺失时主次配置仍保留，实际主驾自动让给可用引擎。
  if (p.primary === "pi" && ctx.piAvailable === false) {
    const sec = ENGINE_CATALOG[p.secondary];
    const lead = sec?.canLead ? p.secondary : "yuanshu";
    return { lead, wanted: p.primary, deferred: p.primary, reason: "unavailable" };
  }
  // 非 SDK 原生通道只让兼容适配器兜底；dsh / 元枢有自己的通道，不受模型下拉绑架
  if (ctx.nativeChannel === false && p.primary === "pi") {
    return { lead: "yuanshu", wanted: p.primary, deferred: "pi", reason: "non-native" };
  }
  const prim = ENGINE_CATALOG[p.primary];
  if (prim?.canLead) return { lead: p.primary, wanted: p.primary, deferred: null, reason: "primary" };
  const sec = ENGINE_CATALOG[p.secondary];
  const lead = sec?.canLead ? p.secondary : "yuanshu";
  return { lead, wanted: p.primary, deferred: p.primary, reason: "cannot-lead" };
}

export function leadNote(decision) {
  const names = { yuanshu: "元枢", pi: "兼容适配器", dsh: "dsh" };
  const lead = names[decision?.lead] || decision?.lead || "元枢";
  if (decision?.reason === "non-native") return `本轮主引擎 · ${lead}（该通道走自制循环）`;
  if (decision?.reason === "unavailable") return `本轮主引擎 · ${lead}（pi 适配器不可用，已自动让路）`;
  if (decision?.deferred) {
    const other = names[decision.deferred] || decision.deferred;
    return `本轮主引擎 · ${lead}（${other} 主驾让路）`;
  }
  return `本轮主引擎 · ${lead}`;
}

let _evalAt = 0;
let _evalReport = null;
const EVAL_TTL_MS = 5 * 60_000;

export async function describePair(pair = loadEnginePair(), ctx = {}) {
  const p = (() => { try { return normalizePair(pair); } catch { return { ...DEFAULT_PAIR }; } })();
  const decision = resolveLead(p, ctx);
  if (!_evalReport || Date.now() - _evalAt > EVAL_TTL_MS) {
    _evalReport = await runYuanshuEval();
    _evalAt = Date.now();
  }
  return {
    ...p,
    catalog: Object.values(ENGINE_CATALOG),
    lead: decision.lead,
    deferred: decision.deferred,
    reason: decision.reason,
    eval: _evalReport,
  };
}
