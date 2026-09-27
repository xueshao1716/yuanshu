// 会话三主分组：工作会话 / 小语真测 / 小语终端
// 分组写入 session_info.group；未写入时按名字与 cwd 推断。Cursor 家目录会话标 foreign，不进侧栏。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LISTED_GROUPS = ["workspace", "test", "terminal"];
const LISTED = new Set(LISTED_GROUPS);

export function isListedGroup(group) {
  return LISTED.has(group);
}

export function isPingName(name) {
  const n = String(name || "").trim();
  return /只回复|请只回复|Reply with|回复严格仅|两个字|OK-GEMINI|OK-CLAUDE|OK-GROK|OK-TUI/i.test(n);
}

function isTerminalName(name) {
  return /外部联系|微信|WeChat|Matrix|小语\s*·\s*外部/i.test(String(name || ""));
}

function isForeignName(name) {
  return /subagent-worker|cursor提示/i.test(String(name || ""));
}

function isWorkshopShot(name) {
  return /技能的执行者|ppt-html|ppt-generator|novel-forge/.test(String(name || ""));
}

function sameCwd(a, b) {
  if (!a || !b) return false;
  try { return path.resolve(a) === path.resolve(b); } catch { return false; }
}

function isHomeCwd(cwd) {
  if (!cwd) return false;
  try { return path.resolve(cwd) === path.resolve(os.homedir()); } catch { return false; }
}

export function classifySessionGroup({ name = "", cwd = "", group = "", workspaceCwd = "" } = {}) {
  if (LISTED.has(group)) return group;
  const n = String(name || "").trim();
  if (/^(\[真测\]|真测[·.:：]?|E2E)/i.test(n)) return "test";
  if (isPingName(n)) return "test"; // ping 探活名一律归 test（09-04 去家目录特判）
  if (isTerminalName(n)) return "terminal";
  if (sameCwd(cwd, workspaceCwd)) return "workspace";
  // 09-04 修复：家目录 cwd 不再强制 foreign——伙伴的终端 pi 会话就在家目录跑，一刀切会把正在聊的会话藏掉。
  // 只按名字藏杂音（subagent/cursor worker 等）；家目录的正常会话落 terminal，进侧栏。
  if (isForeignName(n)) return "foreign";
  if (!cwd) return "workspace";
  return "terminal";
}

export function isJunkSession(s = {}) {
  if (s.pinned) return false;
  const name = String(s.name || "").trim();
  if (/外部联系/.test(name)) return false;
  const now = s.now ?? Date.now();
  const minAgeMs = s.minAgeMs ?? 0;
  const updated = Date.parse(s.updatedAt || 0);
  if (Number.isFinite(updated) && now - updated < minAgeMs) return false;
  const msgs = Number(s.messageCount) || 0;
  if (isWorkshopShot(name) && msgs <= 2) return true;
  if (isPingName(name) && msgs <= 3) return true;
  if ((s.group === "test" || /^(\[真测\]|真测|E2E)/i.test(name)) && msgs <= 3) return true;
  if (msgs <= 1 && (!name || name === "新会话" || name === "(未命名)")) return true;
  if (msgs <= 2 && /^hi$/i.test(name)) return true;
  return false;
}

export function planSweep(sessions, { now = Date.now(), minAgeMs = 0, pinnedIds = new Set() } = {}) {
  const ids = [];
  for (const s of sessions || []) {
    if (isJunkSession({ ...s, pinned: s.pinned || pinnedIds.has(s.id), now, minAgeMs })) ids.push(s.id);
  }
  return { ids, kept: (sessions || []).length - ids.length };
}

export async function runSessionSweep({ sessions, pinnedIds, now, minAgeMs, dryRun, deleteSession }) {
  const plan = planSweep(sessions, { now, minAgeMs, pinnedIds });
  if (dryRun || typeof deleteSession !== "function") {
    return { ok: true, dryRun: true, ids: plan.ids, swept: plan.ids.length, kept: plan.kept };
  }
  const ids = [];
  for (const id of plan.ids) {
    try { await deleteSession(id); ids.push(id); } catch {}
  }
  return { ok: true, dryRun: false, ids, swept: ids.length, kept: plan.kept };
}

export function appendSessionGroup(file, group, name) {
  if (!file || !LISTED.has(group) || !fs.existsSync(file)) return false;
  const line = JSON.stringify({
    type: "session_info",
    name: name || undefined,
    group,
    timestamp: new Date().toISOString(),
  });
  try {
    const cur = fs.readFileSync(file, "utf8");
    const prefix = cur && !cur.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(file, prefix + line + "\n");
    return true;
  } catch {
    return false;
  }
}
