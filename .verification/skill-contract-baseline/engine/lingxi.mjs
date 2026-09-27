// ══════════════════════════════════════════════════════════
// engine/lingxi.mjs —— 灵犀（双向灵感池）
// 用户和小语各自的灵感分源记录：用户随时「记灵犀」，小语工作中冒出的
// 与当前方向无关的意外设计灵感也记进来（source 分开），攒着有空一起过：
// 有用的采纳展开工作/辅助进化，没用的归档。
// 存储：WS_ROOT/灵犀.json（原子写）；小语侧可用 scripts/lingxi.mjs CLI 快速记。
// ══════════════════════════════════════════════════════════
import { readFileSync, existsSync as _exists } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson } from "./atomic-io.mjs";

export const LINGXI_SOURCES = new Set(["user", "xiaoyu"]);
export const LINGXI_STATUSES = new Set(["new", "adopted", "converted", "archived"]);
// 采纳去向（2026-09-03 语义升级）：采纳=立项转化指令，不是归档标记。
// 灵犀=想法漏斗；沉淀台=经验提炼+成品目录；记忆=长期约定——三层分工，不重复。
export const LINGXI_TARGETS = new Set(["skill", "capability", "project", "memory"]);

export function lingXiPath(wsRoot) {
  return join(wsRoot, "灵犀.json");
}

function loadEntries(wsRoot, fsMod = fs) {
  const p = lingXiPath(wsRoot);
  if (!fsMod.existsSync(p)) return [];
  try {
    const d = JSON.parse(fsMod.readFileSync(p, "utf8"));
    return Array.isArray(d?.entries) ? d.entries : [];
  } catch { return []; }
}

function saveEntries(wsRoot, entries, fsMod = fs) {
  atomicWriteJson(lingXiPath(wsRoot), { version: 1, entries }, fsMod);
}

/** 列出灵感（按时间倒序）*/
export function listLingXi(wsRoot, filter = {}, fsMod = fs) {
  let list = loadEntries(wsRoot, fsMod);
  if (filter.source && LINGXI_SOURCES.has(filter.source)) list = list.filter(e => e.source === filter.source);
  if (filter.status && LINGXI_STATUSES.has(filter.status)) list = list.filter(e => e.status === filter.status);
  return list.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
}

/** 记一条灵感。source: 'user'（伙伴的灵感）| 'xiaoyu'（小语的灵感） */
export function addLingXi(wsRoot, { text, source, note }, fsMod = fs) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return { error: "灵感内容不能为空" };
  if (t.length > 2000) return { error: "灵感内容过长（≤2000 字）" };
  if (!LINGXI_SOURCES.has(source)) return { error: "source 必须是 user 或 xiaoyu" };
  const entry = {
    id: randomUUID(),
    source,
    text: t,
    status: "new",
    note: typeof note === "string" ? note.slice(0, 500) : "",
    ts: new Date().toISOString(),
  };
  const entries = loadEntries(wsRoot, fsMod);
  entries.push(entry);
  saveEntries(wsRoot, entries, fsMod);
  return { ok: true, entry };
}

/** 更新状态/备注/去向/产物（采纳转化流转）*/
export function setLingXi(wsRoot, id, patch, fsMod = fs) {
  const entries = loadEntries(wsRoot, fsMod);
  const e = entries.find(x => x.id === id);
  if (!e) return null;
  if (patch?.status !== undefined) {
    if (!LINGXI_STATUSES.has(patch.status)) return null;
    e.status = patch.status;
  }
  if (patch?.target !== undefined) {
    // 采纳必须选去向；已采纳的也能改主意
    if (!LINGXI_TARGETS.has(patch.target)) return null;
    e.target = patch.target;
  }
  if (patch?.artifact !== undefined) e.artifact = String(patch.artifact).slice(0, 500);
  if (patch?.note !== undefined) e.note = String(patch.note).slice(0, 500);
  saveEntries(wsRoot, entries, fsMod);
  return e;
}

/** 删除一条 */
export function removeLingXi(wsRoot, id, fsMod = fs) {
  const entries = loadEntries(wsRoot, fsMod);
  const next = entries.filter(x => x.id !== id);
  if (next.length === entries.length) return false;
  saveEntries(wsRoot, next, fsMod);
  return true;
}
