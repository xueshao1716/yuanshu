// engine/memory-stages.mjs —— canonical / working 记忆分离（2026-09-18）
//
// 抄自 RSIAgent 的第二条：**工作期的临时编辑要丢弃，只有验证过的 canonical memory 才进下一轮。**
//
// 为什么元枢需要它：今天真机上出现过一次同构的事故——一个**没经过任何验证**的技能
// （daily-retro-exec-loop）直接落进了 skills/，还踩了仓库自己的技能契约。
// 元枢的 nudgeSkill 其实有"提案池 + 人审批"的闸，但**闸没装在路上**：
// agent 手里就有 write/edit 工具，它想写 skills/ 就直接写了。纪律挡不住，得在工具层挡。
//
// 所以这一层的形态是：
//   · 规范区（canonical）= skills/** 与 记忆/做梦/{授权状,现役策略,现役探索策略}.json
//   · 写规范区一律先进 记忆/草案区/<id>，带 manifest（目标、哈希、时间、理由）
//   · 只有 `commitStaged({verdict:'PASS'})` 或 `by:'human'` 才真正落到目标路径
//   · 没验证过就一直是草案；人可以随时丢掉
// 注意：服务端"人已批准"的路径（如 applySkillNudge）直接 fs 写，不经工具层，因此不受这道闸影响——
// 闸拦的是"agent 自己顺手写"，不是拦人。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "./atomic-io.mjs";

export function stagingDir(wsRoot) {
  return path.join(wsRoot, "记忆", "草案区");
}

/** 规范区判据：写这些地方必须先过草案区。 */
export function isCanonicalTarget(targetPath, { wsRoot = "" } = {}) {
  const p = path.resolve(String(targetPath || ""));
  const root = path.resolve(String(wsRoot || ""));
  if (!p) return false;
  const rel = root && p.startsWith(root) ? path.relative(root, p).replace(/\\/g, "/") : p.replace(/\\/g, "/");
  if (/(^|\/)skills\//.test(rel) || rel.startsWith("skills/")) return true;
  if (/^记忆\/做梦\/(授权状|现役策略|现役探索策略)\.json$/.test(rel)) return true;
  // 人格定义（2026-09-18）：一份定义决定人格 → 不许直接落盘，先落草案区等人批准。
  if (/^记忆\/人格定义\.json$/.test(rel)) return true;
  return false;
}

const idFor = (target) => `s-${crypto.createHash("sha256").update(String(target)).digest("hex").slice(0, 10)}`;

export function stageWrite(wsRoot, { target, content, reason = "", now = new Date(), fsMod = fs } = {}) {
  if (!wsRoot) return { ok: false, error: "缺 wsRoot：不确定工作区时不许落草案" };
  const t = path.resolve(String(target || ""));
  if (!t) return { ok: false, error: "缺 target" };
  const dir = stagingDir(wsRoot);
  const id = idFor(t);
  try {
    fsMod.mkdirSync(path.join(dir, id), { recursive: true });
    const file = path.join(dir, id, "content");
    fsMod.writeFileSync(file, String(content ?? ""), "utf8");
    const manifest = {
      id, target: t, at: new Date(now).toISOString(), reason: String(reason).slice(0, 300),
      bytes: Buffer.byteLength(String(content ?? ""), "utf8"),
      hash: crypto.createHash("sha256").update(String(content ?? "")).digest("hex").slice(0, 16),
      state: "staged",
    };
    atomicWriteText(path.join(dir, id, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { ok: true, staged: true, id, stagedPath: file, target: t, hash: manifest.hash };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 140) } }
}

export function listStaged(wsRoot, { fsMod = fs } = {}) {
  const dir = stagingDir(wsRoot);
  let ids = [];
  try { ids = fsMod.readdirSync(dir); } catch { return [] }
  const out = [];
  for (const id of ids) {
    try { out.push(JSON.parse(fsMod.readFileSync(path.join(dir, id, "manifest.json"), "utf8"))); } catch { /* 跳过坏条目 */ }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * 提交草案。**只有 PASS 或人批准才放行**——这就是"证据阻止错误经验进入长期记忆"。
 * `verdict` 来自 engine/verifier.mjs；人可以直接 `by:'human'`。
 */
export function commitStaged(wsRoot, id, { verdict = "", by = "", now = new Date(), fsMod = fs } = {}) {
  const dir = path.join(stagingDir(wsRoot), String(id || ""));
  let manifest = null;
  try { manifest = JSON.parse(fsMod.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { return { ok: false, error: "草案不存在" } }
  const approvedByHuman = by === "human";
  if (!approvedByHuman && String(verdict).toUpperCase() !== "PASS") {
    return { ok: false, error: `未通过独立验证（verdict=${verdict || "无"}），不写入规范区`, state: "staged", target: manifest.target };
  }
  try {
    const content = fsMod.readFileSync(path.join(dir, "content"), "utf8");
    fsMod.mkdirSync(path.dirname(manifest.target), { recursive: true });
    fsMod.writeFileSync(manifest.target, content, "utf8");
    atomicWriteText(path.join(dir, "manifest.json"), JSON.stringify({ ...manifest, state: "committed", committedAt: new Date(now).toISOString(), verdict: approvedByHuman ? `human` : "PASS" }, null, 2));
    return { ok: true, committed: true, target: manifest.target, bytes: manifest.bytes, verdict: approvedByHuman ? "human" : "PASS" };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 140) } }
}

export function dropStaged(wsRoot, id, { fsMod = fs } = {}) {
  try { fsMod.rmSync(path.join(stagingDir(wsRoot), String(id || "")), { recursive: true, force: true }); return { ok: true, dropped: id }; }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 140) } }
}
