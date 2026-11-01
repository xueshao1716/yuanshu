// ===== plugin-receipt.mjs —— 装了什么，让她自己知道（2026-11-02）=====
//
// 以前装完插件，只有工具表里多条目，她并不知道"我多了个技能"。
// 这里把已装能力渲染成标记块，同步进 APPEND_SYSTEM.md（她读的那份系统提示）。
import fs from "node:fs";
import path from "node:path";

export const MARK_BEGIN = "<!-- plugins:begin（由已装插件同步，勿手改） -->";
export const MARK_END = "<!-- plugins:end -->";

const KIND_LABEL = { skill: "技能", mcp: "MCP 服务", toolpack: "工具包" };

/** 把已装插件渲染成一段话；没有就返回空串。 */
export function buildReceiptBlock(installed = []) {
  const rows = (Array.isArray(installed) ? installed : [])
    .filter((p) => p && p.id && p.enabled !== false)
    .map((p) => {
      const kind = KIND_LABEL[String(p.type)] || String(p.type || "能力");
      const name = String(p.name || p.id);
      const desc = String(p.description || "").replace(/\s+/g, " ").slice(0, 60);
      return `- ${kind}：${name}${desc ? ` —— ${desc}` : ""}`;
    });
  if (!rows.length) return "";
  return [
    MARK_BEGIN,
    "# 我手上装了什么（插件商店装的，可以直接用）",
    "",
    ...rows,
    "",
    "用之前先想一下它是不是这件事的最佳工具；不确定就直接试，别问伙伴\"我有没有这个能力\"。",
    MARK_END,
  ].join("\n");
}

/** 同步进 APPEND_SYSTEM.md：替换标记块，没有就追加。 */
export function syncPluginReceipt({ agentDir, installed = [], fsMod = fs } = {}) {
  const target = path.join(String(agentDir || ""), "APPEND_SYSTEM.md");
  const block = buildReceiptBlock(installed);
  let old = "";
  try { old = fsMod.readFileSync(target, "utf8") } catch {}
  const a = old.indexOf(MARK_BEGIN);
  const b = old.indexOf(MARK_END);
  let next;
  if (!block) {
    if (a < 0 || b < a) return { ok: true, changed: false };
    next = (old.slice(0, a) + old.slice(b + MARK_END.length)).replace(/\n{3,}/g, "\n\n");
  } else if (a >= 0 && b > a) {
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
