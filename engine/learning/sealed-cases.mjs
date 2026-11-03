// ===== sealed-cases.mjs —— 封存用例（M1 第二片，2026-11-03）=====
//
// 作用：给每个被进化的技能配一份"人挑的考卷"，Agent 只能读、不能改。
// 防的是：提案者自己出题、自己判卷、自己宣布胜利。
//
// 存储：记忆/进化/封存用例/<skill>.json
// 防篡改：文件里记 selfHash（内容哈希），读取时校验；不一致就拒绝使用。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SEALED_REL = path.join("记忆", "进化", "封存用例");
export const MIN_CASES = 20;

export function sealedDir(wsRoot) {
  return path.join(String(wsRoot || "."), SEALED_REL);
}

export function sealedPath(wsRoot, skill) {
  return path.join(sealedDir(wsRoot), `${String(skill || "").replace(/[\\/:*?"<>|]/g, "_")}.json`);
}

const hashOf = (cases) => crypto.createHash("sha256").update(JSON.stringify(cases)).digest("hex").slice(0, 16);

/** 读取并校验封存用例；被改过就返回 ok:false（不静默接受）。 */
export function loadSealed(wsRoot, skill) {
  const file = sealedPath(wsRoot, skill);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return { ok: false, error: "没有封存用例", file } }
  const cases = Array.isArray(doc.cases) ? doc.cases : [];
  const expected = hashOf(cases);
  if (!doc.selfHash) return { ok: false, error: "缺 selfHash，视为未封存", file, cases };
  if (doc.selfHash !== expected) return { ok: false, error: "封存用例被改动过（哈希不符）", file, cases };
  return { ok: true, skill: doc.skill, sealedAt: doc.sealedAt, cases, count: cases.length, file };
}

/** 创建/覆盖封存用例（只应由人触发；Agent 走这条要被上层拒绝）。 */
export function saveSealed(wsRoot, { skill, cases = [], sealedAt = new Date().toISOString(), by = "human" } = {}) {
  if (by !== "human") return { ok: false, error: "封存用例只能由人建立或修改" };
  if (!String(skill || "").trim()) return { ok: false, error: "缺 skill" };
  if (!Array.isArray(cases) || !cases.length) return { ok: false, error: "用例为空" };
  const doc = { skill: String(skill), sealedAt, cases, selfHash: hashOf(cases) };
  const file = sealedPath(wsRoot, skill);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");
  return { ok: true, file, count: cases.length, enough: cases.length >= MIN_CASES };
}

/** 晋级前置检查：≥20 条 + 哈希校验通过。 */
export function canUseAsBenchmark(wsRoot, skill) {
  const r = loadSealed(wsRoot, skill);
  if (!r.ok) return { ok: false, reason: r.error };
  if (r.count < MIN_CASES) return { ok: false, reason: `用例只有 ${r.count} 条，至少需要 ${MIN_CASES}`, count: r.count };
  return { ok: true, count: r.count, sealedAt: r.sealedAt };
}
