// ===== self-change-verify.mjs —— 自证器：这套改动到底证没证过（2026-11-08）=====
//
// 为什么要有它：她可以改 engine/、frontend/src/、tests/，但"改完跑什么、怎么判"以前散在
// validateReal 的调用方手里。这里把"一份自证"固定成五步证据，并且**证明只对这套文件有效**：
//   filesetHash = sha256(排序后的 相对路径 + 各自内容 sha256)
// 文件再动一个字节，哈希就变 —— 旧证明自动作废（准入闸 self-change-admit.mjs 按它判）。
//
// 五步（每步记 {name, ok, skipped?, detail, ms}）：
//   ① syntax：每个改动的 *.mjs 跑 node --check
//   ② import：每个改动的 engine/*.mjs 做一次 import() 冒烟（抓 ERR_MODULE_NOT_FOUND 这类）
//   ③ tests ：engine/foo.mjs → tests/unit/foo*.test.mjs、tests/foo*.test.mjs，跑 node --test；
//              找不到相关测试 → skipped，并在 detail / reason 里明说"无测试覆盖"
//   ④ deps  ：git status --porcelain 除本次文件外不许夹带无关改动（夹带即失败）
//
// 为什么"没有测试覆盖"只标 skipped、不直接判失败：
//   门禁的职责是"跑该跑的、把没跑的如实标出来"，不是拿无关测试冒充覆盖。
//   一律判失败会逼人去删测试或绕过闸；假装通过又会骗过准入。所以缺口写进 detail、reason
//   和 commit message，让"这份证明没覆盖到哪"永远可见。
//   但"全是 skipped"（比如只改了前端文件、又没有任何契约测试）判不通过——那时确实什么都没证。
//
// 纪律：
//   · 所有外部命令必须走注入的 run(cmd, args, opts)；默认实现 execFile（不经 shell）
//   · 每条命令执行前过 engine/tools/security.mjs 的 deny 规则，命中直接判失败
//   · 本模块只读仓库、不写任何文件；自证记录由 self-change-admit.mjs 负责落盘
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { matchDenyRule, DANGEROUS_CMD_RE } from "./tools/security.mjs";

// 服务以 LocalSystem 跑、仓库属主是当前用户，git 会报 dubious ownership，统一带 safe.directory。
export const DEFAULT_GIT = process.env.YUANSHU_GIT || process.env.PI_GIT
  || (process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "git");

// -c core.quotepath=false：中文文件名不给八进制转义，否则"账本/无关改动"分不清；
// -uall：未跟踪目录不折叠成 "?? dir/"，否则新增目录里的文件对不上改动清单。
export const GIT_STATUS_ARGS = ["-c", "safe.directory=*", "-c", "core.quotepath=false", "status", "--porcelain", "-uall"];

// 准入闸自己的账本、以及会话工作区目录：它们出现在 git status 里不算"夹带无关改动"。
const GATE_ARTIFACTS = new Set([
  "记忆/运行时/自证记录.jsonl",
  "记忆/运行时/准入记录.jsonl",
]);

export const STEP_NAMES = ["syntax", "import", "tests", "deps"];

const tail = (s, n = 600) => String(s || "").replace(/\s+$/, "").slice(-n);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** git status 里的账本/工作区条目：属于本闸自身，不算夹带。 */
export function isGateArtifact(rel) {
  const p = String(rel || "").replace(/\\/g, "/");
  return GATE_ARTIFACTS.has(p) || p.startsWith(".worktrees/")
    || p.startsWith("记忆/运行时/") || p === "记忆/" || p === "记忆";
}

/** 归一化文件列表：反斜杠 → /、去 ./、去重、排序；拒绝绝对路径与 .. 越界。 */
export function normalizeFiles(files = []) {
  const errors = [];
  const out = [];
  for (const raw of Array.isArray(files) ? files : []) {
    const rel = String(raw ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!rel) { errors.push("空文件路径"); continue; }
    if (/[\u0000-\u001f\u007f]/.test(rel)) { errors.push(`路径含控制字符：${JSON.stringify(rel)}`); continue; }
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("/")) { errors.push(`不允许绝对路径：${raw}`); continue; }
    if (rel.split("/").some((seg) => seg === ".." || seg === "")) { errors.push(`不允许越界路径：${raw}`); continue; }
    if (!out.includes(rel)) out.push(rel);
  }
  if (!out.length && !errors.length) errors.push("没有改动文件");
  return { ok: errors.length === 0, files: out.sort(), errors };
}

/**
 * 文件集指纹：排序后的 "相对路径\0内容sha256" 再做一次 sha256。
 * 只跟仓库内相对路径与内容有关，与仓库绝对位置无关（工作区→主树的证明可以复用）。
 */
export function computeFilesetHash({ repoRoot, files = [], readFile } = {}) {
  const norm = normalizeFiles(files);
  if (!norm.ok) return { ok: false, errors: norm.errors, filesetHash: "", perFile: {}, missing: [] };
  const read = typeof readFile === "function" ? readFile : (abs) => fs.readFileSync(abs);
  const perFile = {};
  const missing = [];
  for (const rel of norm.files) {
    try {
      perFile[rel] = sha256(read(path.join(String(repoRoot || "."), rel)));
    } catch {
      perFile[rel] = "missing";
      missing.push(rel);
    }
  }
  const filesetHash = sha256(norm.files.map((rel) => `${rel}\u0000${perFile[rel]}`).join("\n"));
  return { ok: true, files: norm.files, filesetHash, perFile, missing };
}

// git status 对含空格/非 ASCII 的路径会加引号并转义（\ooo 是 UTF-8 字节），解码后才能和改动清单对上。
function unquoteGitPath(s) {
  if (!(s.startsWith('"') && s.endsWith('"'))) return s;
  const body = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { bytes.push(...Buffer.from(ch, "utf8")); continue; }
    const next = body[i + 1];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const oct = body.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
    }
    const esc = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
    if (esc[next] !== undefined) { bytes.push(esc[next]); i += 1; continue; }
    bytes.push(...Buffer.from(next, "utf8"));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 解析 git status --porcelain：去状态位、取重命名后的新路径、解引号。 */
export function parsePorcelain(stdout = "") {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let rest = line.slice(3).trimEnd();
    if (/[RC]/.test(code) && rest.includes(" -> ")) rest = rest.split(" -> ").pop();
    const decoded = unquoteGitPath(rest);
    if (decoded) out.push(decoded.replace(/\\/g, "/"));
  }
  return out;
}

/**
 * 改动文件 → 相关测试。
 * 规则：engine/foo.mjs → tests/unit/foo*.test.mjs、tests/foo*.test.mjs；
 * 测试文件本身 → 自己；frontend/src 组件无约定命名时按 basename 包含匹配兜底。
 */
export function mapRelatedTests({
  repoRoot, files = [],
  exists = (abs) => fs.existsSync(abs),
  listDir = (abs) => { try { return fs.readdirSync(abs); } catch { return []; } },
} = {}) {
  const root = String(repoRoot || ".");
  const targets = new Set();
  const uncovered = [];
  const dirs = ["tests/unit", "tests"];
  for (const rel of files) {
    const mapped = [];
    if (/^tests\/.*\.(test|spec)\.(mjs|js)$/i.test(rel)) {
      if (exists(path.join(root, rel))) mapped.push(rel);
      else uncovered.push(rel);
    } else {
      const base = path.basename(rel).replace(/\.(mjs|js|cjs|ts|tsx|jsx)$/i, "");
      for (const dir of dirs) {
        for (const ext of [".test.mjs", ".test.js"]) {
          const cand = `${dir}/${base}${ext}`;
          if (exists(path.join(root, cand))) mapped.push(cand);
        }
        for (const name of listDir(path.join(root, dir))) {
          if (!/\.test\.(mjs|js)$/i.test(name)) continue;
          if (name.startsWith(base)) mapped.push(`${dir}/${name}`);
        }
      }
      if (!mapped.length && rel.startsWith("frontend/src/")) {
        for (const name of listDir(path.join(root, "tests/unit"))) {
          if (/\.test\.(mjs|js)$/i.test(name) && name.includes(base)) mapped.push(`tests/unit/${name}`);
        }
      }
      if (!mapped.length) uncovered.push(rel);
      for (const m of mapped) targets.add(m);
    }
  }
  return { targets: [...targets].sort(), uncovered };
}

/** 命令红线：命中 security.mjs 的 deny 规则或危险命令 → 拒绝执行。 */
export function assertCommandAllowed(cmd, args = []) {
  const line = [cmd, ...args].map(String).join(" ");
  const hit = matchDenyRule(line);
  if (hit) return { ok: false, rule: hit.id, error: `命令命中安全红线 ${hit.id}` };
  if (DANGEROUS_CMD_RE.test(line)) return { ok: false, rule: "dangerous-cmd", error: "命令命中危险命令拦截" };
  return { ok: true };
}

/** 默认执行器：execFile（不经 shell），执行前过安全红线。 */
export function defaultRun(cmd, args = [], opts = {}) {
  const guard = assertCommandAllowed(cmd, args);
  if (!guard.ok) {
    return Promise.resolve({ ok: false, code: -1, stdout: "", stderr: guard.error, denied: true, rule: guard.rule });
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/** import 冒烟用的绝对 URL：带 mtime/size 查询串，避免 ESM 缓存让"改过的模块"仍走旧实例。 */
export function moduleHref(abs) {
  const st = fs.statSync(abs);
  return pathToFileURL(abs).href + `?v=${st.mtimeMs}-${st.size}`;
}

async function timedStep(steps, name, fn) {
  const t0 = Date.now();
  let result;
  try { result = await fn(); }
  catch (e) { result = { ok: false, detail: `步骤异常：${String(e?.message || e).slice(0, 200)}` }; }
  steps.push({ name, ms: Date.now() - t0, ...result });
  return result;
}

/**
 * 跑一次完整自证。
 * @returns {{ok:boolean, filesetHash:string, files:string[], steps:object[], evidence:object, reason:string, at:string}}
 */
export async function verifyChange({ repoRoot, files = [], run, readFile, now = Date.now() } = {}) {
  const root = path.resolve(String(repoRoot || "."));
  const norm = normalizeFiles(files);
  const at = new Date(now).toISOString();
  if (!norm.ok) {
    return {
      ok: false, filesetHash: "", files: [], at,
      steps: [{ name: "files", ok: false, detail: norm.errors.join("；"), ms: 0 }],
      evidence: { files: [], errors: norm.errors },
      reason: `文件列表不合法：${norm.errors.join("；")}`,
    };
  }

  const hash = computeFilesetHash({ repoRoot: root, files: norm.files, readFile });
  if (hash.missing.length) {
    return {
      ok: false, filesetHash: hash.filesetHash, files: norm.files, at,
      steps: [{ name: "files", ok: false, detail: `文件不存在：${hash.missing.join(", ")}（本闸不允许删除文件）`, ms: 0 }],
      evidence: { files: norm.files, missing: hash.missing },
      reason: `文件不存在：${hash.missing.join(", ")}`,
    };
  }

  const exec = typeof run === "function" ? run : defaultRun;
  const commandLog = [];
  const steps = [];

  // ① syntax
  await timedStep(steps, "syntax", async () => {
    const targets = norm.files.filter((f) => /\.mjs$/i.test(f));
    if (!targets.length) return { ok: true, skipped: true, detail: "没有 .mjs 改动，跳过语法检查" };
    const results = [];
    for (const f of targets) {
      const r = await exec(process.execPath, ["--check", f], { cwd: root, timeoutMs: 60000 });
      commandLog.push({ step: "syntax", cmd: process.execPath, args: ["--check", f], ok: !!r?.ok, code: r?.code ?? -1 });
      results.push({ path: f, ok: !!r?.ok, code: r?.code ?? -1, detail: tail(r?.stderr || r?.stdout, 300) });
    }
    const bad = results.filter((x) => !x.ok);
    if (bad.length) {
      return { ok: false, detail: `node --check 失败：${bad.map((b) => `${b.path}（${b.detail || "退出码 " + b.code}）`).join("；")}`, results };
    }
    return { ok: true, detail: `node --check ${targets.length} 个文件：全部通过`, results };
  });

  // ② import 冒烟（放子进程跑：改过的模块可能在顶层 process.exit / 死循环，不能把服务带走）
  await timedStep(steps, "import", async () => {
    const mods = norm.files.filter((f) => /^engine\/.*\.mjs$/i.test(f));
    if (!mods.length) return { ok: true, skipped: true, detail: "没有 engine 模块改动，跳过 import 冒烟" };
    const results = [];
    for (const f of mods) {
      let href;
      try { href = moduleHref(path.join(root, f)); }
      catch { results.push({ path: f, ok: false, error: "文件读不到" }); continue; }
      const code = `await import(${JSON.stringify(href)});`;
      const r = await exec(process.execPath, ["--input-type=module", "-e", code], { cwd: root, timeoutMs: 60000 });
      commandLog.push({ step: "import", cmd: process.execPath, args: ["--input-type=module", "-e", "(import 冒烟)"], ok: !!r?.ok, code: r?.code ?? -1 });
      results.push({ path: f, ok: !!r?.ok, code: r?.code ?? -1, detail: tail(r?.stderr || r?.stdout, 300) });
    }
    const bad = results.filter((x) => !x.ok);
    if (bad.length) {
      return { ok: false, detail: `import 冒烟失败：${bad.map((b) => `${b.path}（${b.detail || b.error || "退出码 " + b.code}）`).join("；")}`, results };
    }
    return { ok: true, detail: `import 冒烟 ${mods.length} 个 engine 模块：全部通过`, results };
  });

  // ③ tests
  await timedStep(steps, "tests", async () => {
    const map = mapRelatedTests({ repoRoot: root, files: norm.files });
    if (!map.targets.length) {
      return { ok: true, skipped: true, detail: `没有找到相关测试：${map.uncovered.join("、")} 无测试覆盖`, targets: [], uncovered: map.uncovered };
    }
    const r = await exec(process.execPath, ["--test", ...map.targets], { cwd: root, timeoutMs: 300000 });
    commandLog.push({ step: "tests", cmd: process.execPath, args: ["--test", ...map.targets], ok: !!r?.ok, code: r?.code ?? -1 });
    const ok = !!r?.ok && (r?.code ?? 0) === 0;
    const gap = map.uncovered.length ? `；无覆盖：${map.uncovered.join("、")}` : "";
    return ok
      ? { ok: true, detail: `node --test ${map.targets.length} 个测试文件：通过${gap}`, targets: map.targets, uncovered: map.uncovered }
      : { ok: false, detail: `node --test 失败（退出码 ${r?.code ?? "?"}）：${tail((r?.stdout || "") + (r?.stderr || ""), 500)}`, targets: map.targets, uncovered: map.uncovered };
  });

  // ④ deps
  await timedStep(steps, "deps", async () => {
    const r = await exec(DEFAULT_GIT, GIT_STATUS_ARGS, { cwd: root, timeoutMs: 60000 });
    if (!r?.ok) return { ok: false, detail: `读不到 git status：${tail(r?.stderr || r?.stdout, 200)}`, porcelain: "", foreign: [] };
    const porcelain = String(r?.stdout || "");
    const changed = parsePorcelain(porcelain);
    const allowed = new Set(norm.files);
    const foreign = changed.filter((f) => !allowed.has(f) && !isGateArtifact(f));
    if (foreign.length) {
      return { ok: false, detail: `工作区夹带无关改动：${foreign.slice(0, 8).join(", ")}${foreign.length > 8 ? ` 等 ${foreign.length} 项` : ""}`, porcelain, foreign };
    }
    return { ok: true, detail: `工作区没有无关改动（本次改动在列 ${changed.filter((f) => allowed.has(f)).length} 个）`, porcelain, foreign };
  });
  const depsStep = steps[steps.length - 1];

  const evidence = {
    files: norm.files,
    fileHashes: hash.perFile,
    uncovered: steps.find((s) => s.name === "tests")?.uncovered || [],
    tests: { targets: steps.find((s) => s.name === "tests")?.targets || [], uncovered: steps.find((s) => s.name === "tests")?.uncovered || [] },
    git: { porcelain: depsStep?.porcelain || "", foreign: depsStep?.foreign || [] },
    commands: commandLog,
    startedAt: at,
    finishedAt: new Date().toISOString(),
  };

  const failed = steps.filter((s) => s.ok === false).map((s) => s.name);
  const skipped = steps.filter((s) => s.skipped).map((s) => s.name);
  const substantive = steps.filter((s) => s.name !== "deps" && !s.skipped);
  const uncovered = evidence.tests.uncovered || [];
  const allOk = failed.length === 0;
  const ok = allOk && substantive.length > 0;
  let reason;
  if (!allOk) reason = `自证未过：${failed.join("、")} 失败`;
  else if (!substantive.length) reason = `自证未过：没有任何实质检查跑过（${skipped.join("、")} 全跳过，只有 git 洁净检查）`;
  else if (uncovered.length) reason = `自证通过，但 ${uncovered.length} 个文件无测试覆盖（${uncovered.join(", ")}）`;
  else reason = `自证通过（${steps.length} 步：${steps.map((s) => s.name).join("/")}）`;

  return { ok, filesetHash: hash.filesetHash, files: norm.files, steps, evidence, reason, at };
}

/**
 * changeId → 改动文件。
 * 先找隔离工作区 .worktrees/auto-<changeId>（她干活的地方），再退回自改提案台账里的 files。
 */
export async function resolveChangeFiles({ repoRoot, changeId, run } = {}) {
  const root = path.resolve(String(repoRoot || "."));
  const id = String(changeId || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return { ok: false, error: "changeId 不合法（只允许字母数字 _ . -）" };
  const exec = typeof run === "function" ? run : defaultRun;

  const wt = path.join(root, ".worktrees", `auto-${id}`);
  if (fs.existsSync(wt)) {
    const st = await exec(DEFAULT_GIT, GIT_STATUS_ARGS, { cwd: wt, timeoutMs: 60000 });
    if (!st?.ok) return { ok: false, error: `读不到工作区改动：${tail(st?.stderr || st?.stdout, 160)}` };
    const files = parsePorcelain(st?.stdout).filter((f) => !isGateArtifact(f));
    if (!files.length) return { ok: false, error: "该工作区里没有改动" };
    return { ok: true, repoRoot: wt, files, source: "worktree" };
  }

  try {
    const ledger = path.join(root, "记忆", "运行时", "自改提案.jsonl");
    const rows = fs.readFileSync(ledger, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const hit = [...rows].reverse().find((r) => r.id === id && Array.isArray(r.files) && r.files.length);
    if (hit) return { ok: true, repoRoot: root, files: hit.files, source: "proposal" };
  } catch {}
  return { ok: false, error: "认不出 changeId（没有对应工作区或提案）" };
}
