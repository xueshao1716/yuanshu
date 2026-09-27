// 元枢磁盘工作记忆（Planning with Files）：每会话三份 md，开轮从接缝注入
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicWriteText } from "./atomic-io.mjs";
import { shouldInjectFullMemory } from "./context-loader.mjs";

const FILES = {
  task_plan: "task_plan.md",
  findings: "findings.md",
  progress: "progress.md",
};
const MAX = { task_plan: 8000, findings: 12000, progress: 8000 };
const INJECT = { task_plan: 2500, findings: 2000, progress: 2000 };

let _root = "";
let currentSession = "default";

export const PLAN_FILES_SCHEMA = {
  type: "function",
  function: {
    name: "plan_files",
    description: "会话磁盘工作记忆。file=task_plan 覆盖阶段清单；file=findings 追加研究发现/决策；file=progress 追加操作、验收和失败。多步长任务用这个；短清单仍用 todo_write。",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["task_plan", "findings", "progress"] },
        content: { type: "string" },
        failed: { type: "boolean", description: "progress 用：这次是失败" },
      },
      required: ["file", "content"],
    },
  },
};

export function initYuanshuWorkmem(root) {
  _root = String(root || "").trim();
  return _root;
}

export function bindWorkmemSession(id) {
  currentSession = safePlanId(id);
  return currentSession;
}

export function safePlanId(id) {
  const s = String(id || "default")
    .replace(/\.\./g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
  return s || "default";
}

function workRoot() {
  return _root || path.join(os.homedir(), ".pi", "agent", "yuanshu-work");
}

function planDir(sessionId) {
  const root = path.resolve(workRoot());
  const id = safePlanId(sessionId);
  const dir = path.resolve(root, id);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error("工作记忆路径越界");
  return dir;
}

function readFile(sessionId, key) {
  try {
    return fs.readFileSync(path.join(planDir(sessionId), FILES[key]), "utf8");
  } catch {
    return "";
  }
}

function clipTail(text, max) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return s.slice(s.length - max);
}

function stamp() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}`;
}

export function writePlanFile(sessionId, file, content, { failed = false } = {}) {
  const key = String(file || "");
  if (!FILES[key]) throw new Error("file 只能是 task_plan / findings / progress");
  const dir = planDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, FILES[key]);
  const body = String(content || "").trim();
  if (!body) throw new Error("content 不能空");
  let next = body;
  if (key === "findings" || key === "progress") {
    const prev = readFile(sessionId, key);
    const line = key === "progress" && failed ? `- ${stamp()} FAIL ${body}` : `- ${stamp()} ${body}`;
    next = prev ? `${prev.replace(/\n*$/, "")}\n${line}` : line;
  }
  next = next.slice(0, MAX[key]);
  atomicWriteText(fp, next.endsWith("\n") ? next : next + "\n");
  return readPlanPack(sessionId);
}

export function readPlanPack(sessionId = currentSession) {
  const plan = readFile(sessionId, "task_plan");
  const findings = readFile(sessionId, "findings");
  const progress = readFile(sessionId, "progress");
  return {
    plan,
    findings,
    progress,
    hasAny: !!(plan.trim() || findings.trim() || progress.trim()),
  };
}

export function formatPlanPrompt(sessionId = currentSession, { message = "" } = {}) {
  const pack = readPlanPack(sessionId);
  if (pack.hasAny) {
    const parts = ["【工作记忆·磁盘】刷新后仍在。改计划用 plan_files。"];
    if (pack.plan.trim()) parts.push(`### task_plan\n${clipTail(pack.plan, INJECT.task_plan)}`);
    if (pack.findings.trim()) parts.push(`### findings\n${clipTail(pack.findings, INJECT.findings)}`);
    if (pack.progress.trim()) parts.push(`### progress\n${clipTail(pack.progress, INJECT.progress)}`);
    return parts.join("\n\n");
  }
  if (shouldInjectFullMemory(message)) {
    return "【工作记忆】多步任务先 plan_files 写 task_plan；学到的用 file=findings 追加；失败和验收写 file=progress。短清单仍用 todo_write。";
  }
  return "";
}

export function planFilesExecutor(sessionId = currentSession) {
  return (args = {}) => {
    try {
      const pack = writePlanFile(sessionId || currentSession, args.file, args.content, { failed: !!args.failed });
      return { text: formatPlanPrompt(sessionId || currentSession, { message: "继续" }), isError: false, pack };
    } catch (e) {
      return { text: String(e?.message || e).slice(0, 200), isError: true };
    }
  };
}

export function planFilesExtraExecutors() {
  return {
    plan_files: (args) => planFilesExecutor(currentSession)(args),
  };
}
