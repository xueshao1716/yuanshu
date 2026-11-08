// ===== self-change-admit.mjs —— 准入闸：自证不过，不许进仓库（2026-11-08）=====
//
// 这是"自进化"缺的最后一环：她自己改完 → 自证器（self-change-verify.mjs）出证据 →
// 本闸核对"这份证据是不是还对得上现在这套文件" → 对得上才 git add 这几个文件并 commit。
//
// 拒绝条件（每条给明确 code + reason）：
//   invalid      文件列表不合法（绝对路径 / .. 越界 / 空）
//   policy       超出自改边界（engine/self-change.mjs 的 POLICY：目录、数量、单文件大小）
//   denied       命中 engine/tools/security.mjs：受保护路径 / 命令红线
//   missing      文件不存在（本闸不支持删除）
//   no_record    没有自证记录（没先跑 verify）
//   verify_failed 最近一次自证失败
//   expired      自证过期（默认 30 分钟）
//   stale        filesetHash 与当前文件实际哈希不符（改动过就作废）
//   dirty        工作区夹带无关改动
//   no_changes   没有可提交的改动
//   add_failed / commit_failed  git 失败
//
// 通过后只做 `git add -- <files>` + `git commit -m <msg> -- <files>`，**默认不 push**。
// 记录落 记忆/运行时/自证记录.jsonl 与 记忆/运行时/准入记录.jsonl（相对 wsRoot，各保留最近 200 条）。
// 生产里 wsRoot 传运行时根（WS_ROOT），账本不写进代码仓，免得自证记录自己变成"夹带改动"。
import fs from "node:fs";
import path from "node:path";
import { checkChange, POLICY } from "./self-change.mjs";
import { computeFilesetHash, normalizeFiles, parsePorcelain, isGateArtifact, assertCommandAllowed, defaultRun, DEFAULT_GIT, GIT_STATUS_ARGS } from "./self-change-verify.mjs";
import { isProtectedPath } from "./tools/security.mjs";

export const MAX_RECORDS = 200;
export const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
export const VERIFY_LEDGER = path.join("记忆", "运行时", "自证记录.jsonl");
export const ADMIT_LEDGER = path.join("记忆", "运行时", "准入记录.jsonl");

const tail = (s, n = 240) => String(s || "").replace(/\s+$/, "").slice(-n);
const reject = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

function ledgerFile(wsRoot, rel) {
  return path.join(String(wsRoot || "."), rel);
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** 追加一条记录，只保留最近 200 条；临时文件 + rename，避免读到半截。 */
function appendRecord(wsRoot, rel, record) {
  const file = ledgerFile(wsRoot, rel);
  const rows = readJsonl(file);
  rows.push(record);
  const kept = rows.slice(-MAX_RECORDS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  fs.renameSync(tmp, file);
  return { ok: true, kept: kept.length };
}

const sameFiles = (a = [], b = []) => {
  const x = [...new Set(Array.isArray(a) ? a : [])].sort();
  const y = [...new Set(Array.isArray(b) ? b : [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** 落一条自证记录（verify 接口跑完就记；admit 只认这条记录，不认调用方嘴上的 ok）。 */
export function recordVerification(wsRoot, verdict = {}, { now = Date.now() } = {}) {
  const rawFiles = verdict.files || verdict.evidence?.files || [];
  const files = normalizeFiles(rawFiles).files;
  const record = {
    at: new Date(now).toISOString(),
    filesetHash: String(verdict.filesetHash || ""),
    files,
    ok: verdict.ok === true,
    steps: (Array.isArray(verdict.steps) ? verdict.steps : []).map((s) => ({
      name: String(s?.name || ""),
      ok: s?.ok === true,
      skipped: s?.skipped === true,
      ms: Number(s?.ms) || 0,
      detail: String(s?.detail || "").slice(0, 300),
    })),
    reason: String(verdict.reason || "").slice(0, 300),
    uncovered: [...new Set(Array.isArray(verdict.evidence?.tests?.uncovered) ? verdict.evidence.tests.uncovered : [])].sort(),
  };
  try {
    appendRecord(wsRoot, VERIFY_LEDGER, record);
    return { ok: true, record };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160), record };
  }
}

export function listVerifications(wsRoot, { limit = 50 } = {}) {
  return readJsonl(ledgerFile(wsRoot, VERIFY_LEDGER)).slice(-Math.max(1, limit)).reverse();
}

export function listAdmissions(wsRoot, { limit = 50 } = {}) {
  return readJsonl(ledgerFile(wsRoot, ADMIT_LEDGER)).slice(-Math.max(1, limit)).reverse();
}

/** 面板用：自证 + 准入按时间倒序合并。 */
export function listLedger(wsRoot, { limit = 50 } = {}) {
  const items = [
    ...readJsonl(ledgerFile(wsRoot, VERIFY_LEDGER)).map((r) => ({ kind: "verify", ...r })),
    ...readJsonl(ledgerFile(wsRoot, ADMIT_LEDGER)).map((r) => ({ kind: "admit", ...r })),
  ];
  return items
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, Math.max(1, limit));
}

/** commit message 模板：自证摘要 + fileset 指纹 + note（默认不 push）。 */
export function buildCommitMessage({ files = [], filesetHash = "", steps = [], uncovered = [], note = "", at = Date.now() } = {}) {
  const stepLine = steps
    .map((s) => `${s.name}=${s.ok === false ? "fail" : (s.skipped ? "skipped" : "ok")}`)
    .join(" ");
  const iso = new Date(Number(at) || Date.now()).toISOString();
  const lines = [
    `自证通过：${files.length} 个文件（fileset ${String(filesetHash).slice(0, 12)}）`,
    "",
    `steps: ${stepLine || "(无)"}`,
    `verify: ${iso}`,
  ];
  if (uncovered.length) lines.push(`无测试覆盖：${uncovered.join(", ")}`);
  const cleanNote = String(note || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (cleanNote) lines.push(`note: ${cleanNote}`);
  lines.push("", "Verified-By: self-change-verify", `Verified-Fileset: ${String(filesetHash).slice(0, 12)}`);
  return lines.join("\n");
}

/**
 * 准入判定 + 提交（只提交这套文件，默认不 push）。
 * @returns {{ok:boolean, code?:string, reason?:string, commit?:string, filesetHash?:string, files?:string[], message?:string, pushed?:boolean}}
 */
export async function admit({
  repoRoot, files = [], verdict, now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS, note = "", run, wsRoot,
} = {}) {
  const root = path.resolve(String(repoRoot || "."));
  const stateRoot = String(wsRoot || repoRoot || ".");
  const exec = typeof run === "function" ? run : defaultRun;

  const norm = normalizeFiles(files);
  if (!norm.ok) return reject("invalid", `文件列表不合法：${norm.errors.join("；")}`);

  // ① 自改边界（与"她能不能改这个文件"同一套 POLICY）
  const bound = checkChange({ files: norm.files });
  if (!bound.ok) return reject("policy", `违反自改边界：${bound.errors.join("；")}`);

  // ② 安全红线：受保护路径（人格/宪法/凭据）连提交都不许
  const protectedHits = norm.files.filter((f) => isProtectedPath(path.join(root, f)));
  if (protectedHits.length) return reject("denied", `受保护文件不允许提交：${protectedHits.join(", ")}`);

  // ③ 单文件大小（POLICY.maxBytesPerFile）
  for (const f of norm.files) {
    try {
      const size = fs.statSync(path.join(root, f)).size;
      if (size > POLICY.maxBytesPerFile) return reject("policy", `文件过大：${f}（${size} > ${POLICY.maxBytesPerFile} 字节）`);
    } catch {
      return reject("missing", `文件不存在：${f}（本闸不允许删除文件）`);
    }
  }

  // ④ 当前文件集指纹：证明只对这套内容有效
  const current = computeFilesetHash({ repoRoot: root, files: norm.files });
  if (!current.ok) return reject("invalid", `算不出文件集指纹：${current.errors.join("；")}`);
  if (current.missing.length) return reject("missing", `文件不存在：${current.missing.join(", ")}（本闸不允许删除文件）`);

  // ⑤ 找这份文件集最近一次自证
  const records = listVerifications(stateRoot, { limit: MAX_RECORDS });
  const sameSet = records.filter((r) => sameFiles(r.files, norm.files));
  if (!sameSet.length) return reject("no_record", "没有自证记录：先调 POST /api/self-change/verify 跑通自证");
  const rec = sameSet[0];
  if (rec.ok !== true) return reject("verify_failed", `最近一次自证失败（${rec.reason || "见自证记录"}），不允许入库`);
  const verifiedAt = Date.parse(String(rec.at || ""));
  if (!Number.isFinite(verifiedAt)) return reject("no_record", "自证记录的时间坏了，请重新自证");
  const age = now - verifiedAt;
  if (age > maxAgeMs) {
    return reject("expired", `自证已过期（${Math.round(age / 60000)} 分钟 > ${Math.round(maxAgeMs / 60000)} 分钟），请重新自证`);
  }
  if (age < -60 * 1000) return reject("no_record", "自证记录时间是未来，拒绝采信");

  if (rec.filesetHash !== current.filesetHash) {
    return reject("stale", "改动在自证之后又被改过（filesetHash 不符），这份自证作废，请重新自证");
  }

  // 调用方可另传 verdict 交叉核对；但它不能替代账本里的记录
  if (verdict && typeof verdict === "object") {
    if (verdict.ok === false) return reject("verify_failed", "传入的自证判决是失败");
    if (verdict.filesetHash && verdict.filesetHash !== current.filesetHash) {
      return reject("stale", "传入的自证与当前文件不符（filesetHash 不符）");
    }
  }

  // ⑥ 夹带检查：此刻的 git status 只能有这套文件（自证后别人又改了别的也不行）
  const st = await exec(DEFAULT_GIT, GIT_STATUS_ARGS, { cwd: root, timeoutMs: 60000 });
  if (!st?.ok) return reject("commit_failed", `读不到 git status：${tail(st?.stderr || st?.stdout, 200)}`);
  const allowed = new Set(norm.files);
  const foreign = parsePorcelain(st?.stdout).filter((f) => !allowed.has(f) && !isGateArtifact(f));
  if (foreign.length) {
    return reject("dirty", `工作区夹带无关改动：${foreign.slice(0, 8).join(", ")}${foreign.length > 8 ? ` 等 ${foreign.length} 项` : ""}，先清理再准入`);
  }

  // ⑦ 命令红线（security.mjs）：add / commit 的命令形状先过 deny
  const addGuard = assertCommandAllowed(DEFAULT_GIT, ["add", "--", ...norm.files]);
  if (!addGuard.ok) return reject("denied", addGuard.error);
  const commitGuard = assertCommandAllowed(DEFAULT_GIT, ["commit", "-m"]);
  if (!commitGuard.ok) return reject("denied", commitGuard.error);

  // ⑧ 只 add 这套文件；只 commit 这套文件（带 pathspec，别把别人 staged 的东西卷进来）
  const add = await exec(DEFAULT_GIT, ["-c", "safe.directory=*", "add", "--", ...norm.files], { cwd: root, timeoutMs: 120000 });
  if (!add?.ok) return reject("add_failed", `git add 失败：${tail(add?.stderr || add?.stdout, 200)}`);

  const message = buildCommitMessage({
    files: norm.files,
    filesetHash: current.filesetHash,
    steps: rec.steps || [],
    uncovered: rec.uncovered || [],
    note,
    at: verifiedAt,
  });
  const commit = await exec(DEFAULT_GIT, ["-c", "safe.directory=*", "commit", "-m", message, "--", ...norm.files], { cwd: root, timeoutMs: 120000 });
  if (!commit?.ok) {
    const text = `${commit?.stdout || ""}\n${commit?.stderr || ""}`;
    if (/nothing to commit|no changes added|nothing added to commit|无文件要提交/i.test(text)) {
      return reject("no_changes", "没有可提交的改动（工作区已干净，或这些改动已经在 HEAD 里了）");
    }
    return reject("commit_failed", `git commit 失败：${tail(text, 200)}`);
  }

  const head = await exec(DEFAULT_GIT, ["-c", "safe.directory=*", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 60000 });
  const commitHash = String(head?.stdout || "").trim().split(/\s+/)[0] || "";
  if (!head?.ok || !/^[0-9a-f]{7,64}$/i.test(commitHash)) {
    return reject("commit_failed", `提交成功但读不到 commit hash：${tail(head?.stderr || head?.stdout, 160)}`);
  }

  const admission = {
    at: new Date(now).toISOString(),
    filesetHash: current.filesetHash,
    files: norm.files,
    ok: true,
    steps: rec.steps || [],
    commit: commitHash,
    verifiedAt: rec.at,
    note: String(note || "").replace(/\s+/g, " ").trim().slice(0, 200),
    pushed: false,
  };
  let recorded = true;
  try { appendRecord(stateRoot, ADMIT_LEDGER, admission); } catch { recorded = false; }

  return {
    ok: true,
    commit: commitHash,
    filesetHash: current.filesetHash,
    files: norm.files,
    message,
    pushed: false,
    verifiedAt: rec.at,
    recorded,
  };
}
