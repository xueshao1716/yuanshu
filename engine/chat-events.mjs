// ===== chat-events.mjs —— 任务进度 / agent 事件环 / 工具输出落盘（2026-11-05 从 unified-chat.mjs 拆出）=====
//
// 这三块都是"给前端看的旁路状态"：任务跑到哪一步、她在干嘛、超大工具输出存哪。
// 跟主对话流程只有写入关系、没有反向依赖，所以最安全。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { json } from "./http-utils.mjs";

// Agent 活动事件环（借鉴 dsh 轨迹设计：小语在干嘛，前端实时可见）
// 内存环：保留最近 200 条，不持久化（历史仍在 session 文件）
// ============================================================
const agentEventRing = [];
const AGENT_EVENT_MAX = 200;

// ── 任务进度快照：前端息屏/断线/刷新后，可查"任务是否还在跑、跑到哪一步" ──
// 内存 Map（sessionId → 快照）；任务结束保留 60s 供前端查"刚结束"，之后自动清除
export const taskProgress = new Map();
export function touchTask(sessionId, patch = {}) {
  if (!sessionId) return;
  const t = taskProgress.get(sessionId) || { sessionId, status: "running", stage: "处理中", startedAt: Date.now() };
  Object.assign(t, patch, { updatedAt: Date.now() });
  taskProgress.set(sessionId, t);
}
export function clearTask(sessionId, status = "done") {
  if (!sessionId) return;
  const t = taskProgress.get(sessionId);
  if (!t) return;
  t.status = status;
  t.updatedAt = Date.now();
  // 60s 后清除，前端可查"刚结束"；unref：纯内存清理，不该阻止进程退出（也避免测试被挂 60s）
  setTimeout(() => { taskProgress.delete(sessionId); }, 60000).unref?.();
}

export function handleAgentEventIn(req, res, body) {
  if (!body || !body.type) return json(res, 400, { error: "bad event" });
  const ev = {
    agent: body.agent || "小语",
    type: String(body.type).replace(/^pi\//, ""),
    data: body.data || {},
    ts: body.ts || new Date().toISOString(),
  };
  agentEventRing.push(ev);
  if (agentEventRing.length > AGENT_EVENT_MAX) agentEventRing.shift();
  return json(res, 200, { ok: true });
}

export function handleAgentEventOut(res, persistent = null) {
  if (!persistent) return json(res, 200, { events: agentEventRing.slice(-80) });
  // Do not count two sources as two completed tasks. Identified native runs win;
  // legacy events without identity remain explicitly labelled external reports.
  const ids = new Set(persistent.events.map(e => e.runId));
  const external = agentEventRing.slice(-20).filter(e => !ids.has(e.data?.runId))
    .map(e => ({ ...e, source: 'external' }));
  return json(res, 200, { ...persistent,
    events: [...persistent.events, ...external].sort((a, b) => new Date(a.ts) - new Date(b.ts)).slice(-80) });
}

// ── 工具大响应落盘（08-29 TrueForge 策略②对标）：>50KB 写文件，上下文只留预览+路径 ──
// 之前 truncate 直接丢信息；落盘后模型可用 read 工具按需读全文。目录按日分桶，7 天前的自动清。
// M1 路径外部化：落盘目录进系统临时目录，跨机器可移植
const TOOL_SPILL_DIR = path.join(os.tmpdir(), "pi-web-toolout");
const TOOL_SPILL_LIMIT = 50 * 1024;
export function spillIfHuge(toolName, text) {
  const s = String(text || "");
  if (s.length <= TOOL_SPILL_LIMIT) return s;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(TOOL_SPILL_DIR, day);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${toolName}-${Date.now()}.txt`);
    fs.writeFileSync(file, s);
    // 清 7 天前
    for (const d of fs.readdirSync(TOOL_SPILL_DIR)) {
      const p = path.join(TOOL_SPILL_DIR, d);
      if (d < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
    }
    const preview = s.slice(0, 800);
    return `${preview}\n\n[完整输出 ${s.length} 字符已落盘: ${file} — 需要更多内容时用 read 工具读取该路径]`;
  } catch { return s.slice(0, TOOL_SPILL_LIMIT) + "\n...[截断]"; }
}
