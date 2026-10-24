// ===== gold-facts.mjs —— 黄金事实（每轮必带，不靠词面命中）=====
//
// 为什么需要单独一层：路由是"按这轮问题去捞"的，捞不到就不带。
// 但有些事实跟问题无关、每一轮都必须成立——工作区在哪、源码仓库在哪、装在哪一份、
// 主人的邮箱和 QQ 是多少。这些恰恰是最贵的信息：不知道就得现场重新摸一遍
// （2026-10-24 开新会话读工作记忆，第一件事就是重新确认这四个路径）。
//
// 两条纪律：
//   1. 每条事实都要指得出**来源**（哪个文件推出来的），不写"大概是"；
//   2. 能从活文件推出来的（路径存在性、联系方式）每次现读，不缓存过期值；
//      人工补充的事实放 记忆/运行时/黄金事实.json，可改可删、带写入时间。
//
// 与 `memory` 段的关系：黄金事实排在路由记忆**前面**——路由是"这轮相关"，
// 黄金是"永远成立"，冲突时以黄金事实为准。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadContact } from "./self-model.mjs";

export const GOLD_FILE = path.join("记忆", "运行时", "黄金事实.json");
export const MAX_FACTS = 8;
export const MAX_CHARS = 700;

function goldPath(wsRoot) {
  return path.join(String(wsRoot || "."), GOLD_FILE);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** 存在才算：宁可少一条，也不能把不存在的路径当事实塞给模型。 */
function dirFact(id, label, dir, source) {
  try {
    if (!dir || !fs.existsSync(dir)) return null;
    if (!fs.statSync(dir).isDirectory()) return null;
    return { id, label, text: dir, source };
  } catch { return null; }
}

/** 从环境/安装位置推出的路径事实（每一步都有存在性检查）。 */
export function derivedPathFacts(wsRoot) {
  const out = [];
  const ws = dirFact("workspace", "工作区", wsRoot, "本会话 cwd");
  if (ws) out.push(ws);
  const repo = dirFact("repo", "源码仓库", process.env.YUANSHU_REPO_DIR || "D:\\pi-web", "环境或默认位置");
  if (repo) out.push(repo);
  const install = dirFact(
    "install",
    "安装目录",
    process.env.YUANSHU_APP_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "Yuanshu", "app"),
    "环境或安装器默认位置",
  );
  if (install) out.push(install);
  return out;
}

/** 从 记忆/运行时/主人联系.json 现读；读不到就没有，不猜。 */
export function contactFacts(wsRoot) {
  const out = [];
  try {
    const c = loadContact(wsRoot) || {};
    const bits = [];
    if (c.email) bits.push(`邮箱 ${c.email}`);
    if (c.qq) bits.push(`QQ ${c.qq}`);
    if (bits.length) out.push({ id: "contact", label: "主人联系方式", text: bits.join(" · "), source: "记忆/运行时/主人联系.json" });
  } catch {}
  return out;
}

/** 人工维护的那份（可改可删）。文件不存在时按当前实况播种一次。 */
export function loadGoldFile(wsRoot, { seed = true } = {}) {
  const p = goldPath(wsRoot);
  const raw = readJson(p);
  if (raw && Array.isArray(raw.facts)) return { version: 1, facts: raw.facts };
  if (!seed) return { version: 1, facts: [] };
  const facts = derivedPathFacts(wsRoot).map((f) => ({ ...f, at: Date.now() }));
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ version: 1, facts }, null, 2), "utf8");
  } catch {}
  return { version: 1, facts };
}

export function writeGoldFacts(wsRoot, facts = []) {
  try {
    const clean = (Array.isArray(facts) ? facts : [])
      .filter((f) => f && String(f.text || "").trim())
      .map((f) => ({
        id: String(f.id || "").trim() || `f-${Math.random().toString(36).slice(2, 8)}`,
        label: String(f.label || "").trim() || "事实",
        text: String(f.text).trim(),
        source: String(f.source || "人工").trim(),
        at: Number(f.at) || Date.now(),
      }))
      .slice(0, MAX_FACTS);
    const p = goldPath(wsRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ version: 1, facts: clean }, null, 2), "utf8");
    return { ok: true, facts: clean };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

/**
 * 合并：现读的派生事实优先（存在的路径才是真的），人工条目按 id 去重补位。
 * 超过 MAX_CHARS 就截断——黄金事实是"每轮都带"，不能自己变成新的上下文膨胀源。
 */
export function goldFacts(wsRoot) {
  const seen = new Set();
  const out = [];
  for (const f of [...contactFacts(wsRoot), ...derivedPathFacts(wsRoot)]) {
    if (!f || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  try {
    for (const f of loadGoldFile(wsRoot, { seed: false }).facts || []) {
      const id = String(f.id || "").trim();
      if (!id || seen.has(id) || !String(f.text || "").trim()) continue;
      seen.add(id);
      out.push({ id, label: String(f.label || "事实"), text: String(f.text).trim(), source: String(f.source || "人工") });
    }
  } catch {}
  return out.slice(0, MAX_FACTS);
}

export function goldSection(wsRoot) {
  const facts = goldFacts(wsRoot);
  if (!facts.length) return "";
  const lines = facts.map((f) => `- ${f.label}：${f.text}`);
  let body = lines.join("\n");
  if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + "…";
  return `【黄金事实·每轮必带】以下为已核实的事实，与本轮捞到的记忆冲突时以此为准：\n${body}`;
}
