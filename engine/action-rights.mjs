// ===== action-rights.mjs —— 行动权清单：写进她的系统提示（2026-10-31）=====
//
// 真机事故：微信里她说"写好了，落在 记忆/行动权清单.md"——文件确实写了，
// 但**没有任何代码读它**。等于写进抽屉，行为一点没变。
//
// 这里把它接到 APPEND_SYSTEM.md（pi 通道读的那份），用独立标记块，与人格块互不干扰：
//   <!-- action-rights:begin（由 记忆/行动权清单.md 同步，勿手改） -->
//   …清单正文…
//   <!-- action-rights:end -->
import fs from "node:fs";
import path from "node:path";

export const RIGHTS_REL = path.join("记忆", "行动权清单.md");
export const MARK_BEGIN = "<!-- action-rights:begin（由 记忆/行动权清单.md 同步，勿手改） -->";
export const MARK_END = "<!-- action-rights:end -->";
const MAX_CHARS = 4000;

export function rightsPath(wsRoot) {
  return path.join(String(wsRoot || "."), RIGHTS_REL);
}

export function readRights(wsRoot) {
  try {
    const raw = fs.readFileSync(rightsPath(wsRoot), "utf8").trim();
    return { ok: true, text: raw.slice(0, MAX_CHARS), bytes: raw.length, mtime: fs.statSync(rightsPath(wsRoot)).mtimeMs };
  } catch (e) {
    return { ok: false, text: "", error: `读不到行动权清单：${String(e?.message || e).slice(0, 100)}` };
  }
}

export function buildBlock(text) {
  const body = String(text || "").trim();
  if (!body) return "";
  return [
    MARK_BEGIN,
    "# 行动权清单（我直接做什么 / 必须等伙伴点头什么，以此为准）",
    "",
    body,
    MARK_END,
  ].join("\n");
}

/**
 * 把清单同步进 APPEND_SYSTEM.md：替换标记块，没有就追加。
 * @returns {{ok:boolean, changed:boolean, error?:string}}
 */
export function syncActionRights({ wsRoot, agentDir, fsMod = fs } = {}) {
  const target = path.join(String(agentDir || ""), "APPEND_SYSTEM.md");
  const r = readRights(wsRoot);
  if (!r.ok) return { ok: false, changed: false, error: r.error || "读不到行动权清单" };
  const block = buildBlock(r.text);
  if (!block) return { ok: true, changed: false };
  let old = "";
  try { old = fsMod.readFileSync(target, "utf8") } catch {}
  const a = old.indexOf(MARK_BEGIN);
  const b = old.indexOf(MARK_END);
  let next;
  if (a >= 0 && b > a) {
    next = old.slice(0, a) + block + old.slice(b + MARK_END.length);
  } else {
    next = (old ? old.replace(/\s*$/, "\n\n") : "") + block + "\n";
  }
  if (next === old) return { ok: true, changed: false };
  try {
    fsMod.mkdirSync(path.dirname(target), { recursive: true });
    fsMod.writeFileSync(target, next, "utf8");
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, changed: false, error: String(e?.message || e).slice(0, 160) };
  }
}

/** 从 APPEND_SYSTEM 里摘掉清单块（用于停用） */
export function removeActionRights({ agentDir, fsMod = fs } = {}) {
  const target = path.join(String(agentDir || ""), "APPEND_SYSTEM.md");
  let old = "";
  try { old = fsMod.readFileSync(target, "utf8") } catch { return { ok: true, changed: false } }
  const a = old.indexOf(MARK_BEGIN);
  const b = old.indexOf(MARK_END);
  if (a < 0 || b < a) return { ok: true, changed: false };
  const next = (old.slice(0, a) + old.slice(b + MARK_END.length)).replace(/\n{3,}/g, "\n\n");
  fsMod.writeFileSync(target, next, "utf8");
  return { ok: true, changed: true };
}
