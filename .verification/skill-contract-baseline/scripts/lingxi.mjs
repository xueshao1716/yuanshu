#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// scripts/lingxi.mjs —— 灵犀 CLI（小语侧快速记灵感 + 采纳转化闭环）
// 用法：
//   node scripts/lingxi.mjs add --source xiaoyu --text "意外灵感内容"
//   node scripts/lingxi.mjs list [--source user|xiaoyu] [--status new|adopted|converted|archived]
//   node scripts/lingxi.mjs adopt <id> --target skill|capability|project|memory   （采纳=立项转化指令）
//   node scripts/lingxi.mjs done <id> --artifact "产物路径/commit"                  （转化完成闭环）
// 语义（2026-09-03）：采纳不是归档标记，是转化指令——落地为技能/能力/项目定向/（少数）记忆；
// 灵犀=想法漏斗，沉淀台=经验提炼+成品目录，记忆=长期约定，三层不重复。
// ══════════════════════════════════════════════════════════
import { listLingXi, addLingXi, setLingXi } from "../engine/lingxi.mjs";

const WS_ROOT = process.env.WS_ROOT || "D:/pi-workspace";
const [cmd, ...rest] = process.argv.slice(2);

function arg(name) {
  const i = rest.indexOf("--" + name);
  return i >= 0 ? rest[i + 1] : undefined;
}
function firstId() {
  const raw = rest.find(x => !x.startsWith("--")) || (rest[rest.indexOf("--id") + 1]);
  return raw ? (raw.match(/^[\w-]{8}$/) ? raw : raw) : undefined;
}
// 支持短 id（前 8 位）匹配
function resolveId(id) {
  if (!id) return id;
  if (id.length >= 32) return id;
  const all = listLingXi(WS_ROOT, {});
  const hit = all.find(e => e.id.startsWith(id));
  return hit?.id;
}

if (cmd === "add") {
  const r = addLingXi(WS_ROOT, { text: arg("text"), source: arg("source") || "xiaoyu" });
  if (r.error) { console.error("✗ " + r.error); process.exit(1); }
  console.log(`✓ 已记灵犀 [${r.entry.source}] ${r.entry.id}`);
} else if (cmd === "adopt") {
  const id = resolveId(firstId());
  const target = arg("target");
  const r = setLingXi(WS_ROOT, id, { status: "adopted", target });
  if (!r) { console.error("✗ 灵感不存在或 target 非法（skill|capability|project|memory）"); process.exit(1); }
  console.log(`✓ 已采纳 [${r.target}] ${r.id}\n  下一步：落地后 node scripts/lingxi.mjs done ${r.id.slice(0, 8)} --artifact "产物路径"`);
} else if (cmd === "done") {
  const id = resolveId(firstId());
  const r = setLingXi(WS_ROOT, id, { status: "converted", artifact: arg("artifact") || "" });
  if (!r) { console.error("✗ 灵感不存在"); process.exit(1); }
  console.log(`✓ 已闭环 [${r.status}] ${r.id}${r.artifact ? " → " + r.artifact : ""}`);
} else if (cmd === "list") {
  const entries = listLingXi(WS_ROOT, { source: arg("source"), status: arg("status") });
  const label = { user: "伙伴", xiaoyu: "小语", new: "待过", adopted: "已采纳", converted: "已落地", archived: "已归档" };
  if (!entries.length) { console.log("（空）"); process.exit(0); }
  for (const e of entries) {
    const extra = [e.target ? `→${e.target}` : "", e.artifact ? ` ⚑${e.artifact.slice(0, 50)}` : ""].join("");
    console.log(`[${label[e.source]}·${label[e.status] || e.status}] ${e.ts.slice(0, 16).replace("T", " ")}  ${e.text.replace(/\n/g, " ").slice(0, 80)}${extra}  #${e.id.slice(0, 8)}`);
  }
} else {
  console.log('用法: node scripts/lingxi.mjs add --source xiaoyu --text "..." | list [--source] [--status] | adopt <id> --target skill|capability|project|memory | done <id> --artifact "产物"');
}
