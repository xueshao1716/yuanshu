// ===== doc-diff.mjs —— 工作区文档变化感知（2026-10-27）=====
//
// 抄 A5 的 Diff Engine / EverOS 的文件变化感知：
//   ① 只做"变化检测"，不读全文（mtime + size 就够，避免每次扫几万行）；
//   ② **第一次扫描只建基线**，不报变化（否则一启动就刷一堆"变化"）；
//   ③ 变化要能和**正在做的事**对上号——用文件路径/名与目标文本做关键词比对；
//   ④ 结果落 `记忆/运行时/文档变化.json`（环形，最近 50 条），并进环境事实。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const MANIFEST = path.join("记忆", "运行时", "文档变化.json");
export const MAX_ENTRIES = 50;
export const DOC_EXT = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".ts", ".tsx", ".js", ".mjs", ".py", ".ps1", ".bat"]);
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "bg-jobs", "dist", "build", ".next", "coverage", ".memgit", "Wiki",
  // 2026-10-27 真机：工作区里产物/素材目录极大（4000 文件上限被它们吃满，真文档反而扫不到）
  "out", "output", "交付", "产物", "素材", "temp", "tmp", ".cache", ".worktrees",
]);
export const MAX_FILES = 4000;
export const MAX_DEPTH = 6;

const manFile = (wsRoot) => path.join(String(wsRoot || "."), MANIFEST);

export function readManifest(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(manFile(wsRoot), "utf8"));
    if (raw && typeof raw === "object") return { v: 1, baselineAt: 0, files: {}, changes: [], ...raw };
  } catch {}
  return { v: 1, baselineAt: 0, files: {}, changes: [] };
}

function writeManifest(wsRoot, data) {
  const p = manFile(wsRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...data, v: 1, updatedAt: Date.now() }, null, 2), "utf8");
  return data;
}

/** 走一遍工作区，收集文档指纹（mtime + size）。 */
/**
 * 默认只盯这些位置。**不递归整个工作区**——真机里「工程」有 20 万个文件（生成物），
 * 全量扫会瞬间吃满上限，真正的文档反而扫不到。
 */
export function defaultSpecs() {
  return [
    { root: "文档", depth: 6 },
    { root: "docs", depth: 6 },
    { root: "记忆", depth: 2 },
    { root: "工程", depth: 0 },   // 只扫工程根下的文件，不钻子目录
  ];
}

/** 读用户配置（可选）：记忆/运行时/文档监听.json = {"paths":[{"root":"工程/某项目","depth":4}]} */
export function loadSpecs(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(wsRoot || "."), "记忆", "运行时", "文档监听.json"), "utf8"));
    const paths = Array.isArray(raw?.paths) ? raw.paths : [];
    const specs = paths.map((x) => ({ root: String(x.root || x.path || ""), depth: Math.min(8, Math.max(0, Number(x.depth) || 0)) })).filter((x) => x.root);
    return specs.length ? specs : defaultSpecs();
  } catch { return defaultSpecs() }
}

export function scanDocs({ wsRoot, specs = null, roots = null, maxFiles = MAX_FILES, maxDepth = MAX_DEPTH } = {}) {
  const ws = String(wsRoot || ".");
  const out = new Map();
  const seenRoots = new Set();

  const walk = (dir, depth, depthLimit = maxDepth) => {
    if (out.size >= maxFiles || depth > depthLimit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
    for (const e of entries) {
      if (out.size >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        // 记忆只关心知识/自我，运行时跳过（噪音大）
        if (e.name === "运行时" && full.includes(`${path.sep}记忆${path.sep}`)) continue;
        walk(full, depth + 1, depthLimit);
        continue;
      }
      if (!DOC_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let st;
      try { st = fs.statSync(full) } catch { continue }
      if (st.size > 2 * 1024 * 1024) continue;   // 超大文件不是文档，跳过
      const rel = path.relative(ws, full).replace(/\\/g, "/");
      out.set(rel, { mtime: Math.round(st.mtimeMs), size: st.size });
    }
  };

  const plan = specs || (roots ? roots.map((r) => ({ root: r, depth: maxDepth })) : loadSpecs(ws));
  for (const spec of plan) {
    const abs = path.resolve(ws, spec.root);
    if (!abs.startsWith(path.resolve(ws))) continue;   // 防越界
    if (!fs.existsSync(abs) || seenRoots.has(abs)) continue;
    seenRoots.add(abs);
    const st = fs.statSync(abs);
    const limitDepth = Math.min(maxDepth, Number.isFinite(spec.depth) ? spec.depth : maxDepth);
    if (st.isDirectory()) walk(abs, 0, limitDepth);
    else out.set(path.relative(ws, abs).replace(/\\/g, "/"), { mtime: Math.round(st.mtimeMs), size: st.size });
  }
  return out;
}

/** 把变化与"正在做的事"对上号（关键词重合）。 */
export function relateToTargets(change, targets = []) {
  const base = String(change.path || "").split("/").pop().replace(/\.[^.]+$/, "");
  const tokens = new Set(
    `${base} ${String(change.path || "")}`.toLowerCase()
      .split(/[^\w\u4e00-\u9fa5]+/).filter((t) => t.length >= 2),
  );
  const hits = [];
  for (const t of targets) {
    const text = String(t.text || "").toLowerCase();
    let score = 0;
    for (const token of tokens) if (token.length >= 3 && text.includes(token)) score += 1;
    if (score > 0) hits.push({ id: t.id || null, text: String(t.text || "").slice(0, 60), score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 2);
}

/**
 * 扫一次并对比基线。
 * @returns {{baseline:boolean, added:Array, modified:Array, deleted:Array, total:number}}
 */
export function diffDocs({ wsRoot, targets = [], now = Date.now(), maxFiles = MAX_FILES } = {}) {
  const data = readManifest(wsRoot);
  const current = scanDocs({ wsRoot, maxFiles });
  const prev = data.files || {};
  const added = [], modified = [], deleted = [];

  for (const [rel, info] of current) {
    const before = prev[rel];
    if (!before) { if (data.baselineAt) added.push({ path: rel, ...info }) ; continue }
    if (before.mtime !== info.mtime || before.size !== info.size) modified.push({ path: rel, ...info, prevSize: before.size });
  }
  if (data.baselineAt) {
    for (const rel of Object.keys(prev)) if (!current.has(rel)) deleted.push({ path: rel });
  }

  const isBaseline = !data.baselineAt;
  const changes = [...added, ...modified].map((c) => ({
    ...c,
    at: now,
    related: relateToTargets(c, targets),
  }));

  const next = {
    ...data,
    baselineAt: data.baselineAt || now,
    files: Object.fromEntries([...current].map(([k, v]) => [k, v])),
    changes: isBaseline ? [] : [...changes, ...(data.changes || [])].slice(0, MAX_ENTRIES),
  };
  writeManifest(wsRoot, next);

  return { baseline: isBaseline, added, modified, deleted, total: current.size, changes: next.changes };
}

/** 环境事实里的一行（有变化才非空）。 */
export function docChangesLine({ wsRoot, maxItems = 3, maxAgeMs = 6 * 3600 * 1000, now = Date.now() } = {}) {
  const data = readManifest(wsRoot);
  const recent = (data.changes || []).filter((c) => now - (c.at || 0) <= maxAgeMs);
  if (!recent.length) return "";
  // 同一文件可能既有新增又有修改，按路径去重（保留最新一条）
  const seen = new Set();
  const uniq = recent.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
  const items = uniq.slice(0, maxItems).map((c) => {
    const rel = c.related?.[0];
    return `${c.path}${rel ? `（与「${rel.text}」相关）` : ""}`;
  });
  return `【文档变化】近 ${Math.round(maxAgeMs / 3600000)} 小时有 ${recent.length} 处改动：${items.join("；")}——如果和手上的活有关，先看一眼再继续。`;
}

/** 清空基线（重建时用）。 */
export function resetManifest(wsRoot) {
  writeManifest(wsRoot, { v: 1, baselineAt: 0, files: {}, changes: [] });
  return { ok: true };
}
