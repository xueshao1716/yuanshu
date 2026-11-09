// ===== engine/assembly.mjs —— 能力装配分级（defined → implemented → integrated → controllable）=====
// 2026-11-10
//
// 为什么要有它：林心语那边用 ASSEMBLY_STATUS.md 把每项能力分四级；元枢原来只有「产出新鲜度」
// （engine/vitality.mjs），判的是"有没有产出"，判不了"有没有接上"。今晚连着两次翻车：
// 预告过的闸没人读、正向账本没有调用点——都是"代码写了、导出在、但没人调用"。
// 新鲜度看板对此完全无感：它只看盘上有没有新文件，函数从没被调过它照样可能报绿。
//
// 这个模块只做一件事：把"这套东西到底接没接上"变成**可执行、可复查的判据**，逐级判定，
// 停在哪一级、缺什么，写进 gaps。
//
// 四级判据（缺一级就停，不再往下判）：
//   defined       声明的文件存在（spec.files 任一）；或 spec.constants 里的常量在声明文件里出现
//   implemented   spec.exports 每个都能 import() 到，**且** spec.tests 里任一测试文件存在
//   integrated    非测试代码里真有调用点：spec.callSites 指定文件里出现声明符号
//                 （排除注释、字符串字面量、import/export-from 行；认 `import { x as y }` 别名），
//                 或 spec.wired(ctx) 自定义断言返回真
//   controllable  spec.switches 里任一生效：环境变量 / 配置键 / API 路由 / 闸文件
//                 （另认 flag：CLI 参数。它不在那四类里，是补的一类，证据里会照写）
//
// 这套判不了什么（写在这里，免得以后拿它当"接上了"的充分证明）：
//   · 只判文本里有调用，不判运行时真执行：if (false) 里的调用、死分支、被 try{}catch{} 吞掉的
//     异常，一律算"接了"。
//   · 只判一跳（A 是否调 B）：B 又挂在一个没人调的 C 上，它看不出来（传递死亡）。反过来，
//     调用点在 scripts/ 里也算 integrated——脚本没人跑，这套也判不出来。
//   · 不判频率与效果：调一次和调一万次一样。调了没产出不归它管（那是 vitality 的活）。
//   · 符号匹配是文本级：同名不同模块会互相顶替（failure-attribution 和 run-observability
//     都有 classifyFailure）；所以声明里要挑**辨识度高**的符号，别用 status/promote 这种。
//   · 模板字符串里的 ${} 表达式会被当成字符串整体忽略（拿它拼出来的调用点会漏）。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LEVELS = Object.freeze(["defined", "implemented", "integrated", "controllable"]);
export const MISSING_LEVEL = "missing";
export const LEVEL_LABELS = Object.freeze({
  defined: "声明", implemented: "实现", integrated: "接线", controllable: "可控", missing: "不存在",
});
export const SWITCH_KINDS = Object.freeze(["env", "config", "route", "gate", "flag"]);
export const SWITCH_HINT = "环境变量 / 配置键 / API 路由 / 闸文件";
// 开关探测的默认附加源：路由在 server.mjs，环境变量常在 config.mjs / .env
export const DEFAULT_SWITCH_FILES = Object.freeze(["server.mjs", "config.mjs", ".env"]);

const GAP_WRAP = 46;

const asArray = (v) => (Array.isArray(v)
  ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
  : typeof v === "string" && v.trim() ? [v.trim()] : []);

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 测试代码不算调用点：tests/、test/ 目录。 */
export function isTestPath(rel = "") {
  return /(^|[\\/])tests?([\\/]|$)/i.test(String(rel));
}

/** 简短列举：超过 2 个就折成「A、B 等 N 个」，表里放得下。 */
export function briefList(items = [], max = 2) {
  const list = Array.isArray(items) ? items.filter(Boolean).map(String) : [];
  if (!list.length) return "（空）";
  return list.length <= max ? list.join("、") : `${list.slice(0, max).join("、")} 等 ${list.length} 个`;
}

/**
 * 去掉注释（可选：把字符串字面量也涂成空格）。
 * 注释里的符号不算调用点；字符串里的符号也不算（"applyEvent()" 只是一句话）。
 * 判开关时反过来要 keepStrings：路由/环境变量本来就写在字符串里。
 */
export function stripNonCode(src = "", { keepStrings = false } = {}) {
  const text = String(src);
  let out = "";
  let state = ""; // "" | "line" | "block" | "str"
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "line") {
      if (ch === "\n") { state = ""; out += "\n"; } else { out += " "; }
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") { state = ""; out += "  "; i += 1; continue; }
      out += ch === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "str") {
      if (ch === "\\") { out += "  "; i += 1; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { state = ""; out += ch; continue; }
      out += keepStrings ? ch : (ch === "\n" ? "\n" : " ");
      continue;
    }
    if (ch === "/" && next === "/") { state = "line"; out += "  "; i += 1; continue; }
    if (ch === "/" && next === "*") { state = "block"; out += "  "; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { state = "str"; out += ch; continue; }
    out += ch;
  }
  return out;
}

/**
 * 从源码里解析 `import { a as b }` 的本地别名；返回 Map<声明名, Set<本地名>>。
 * modules 给定时**只认从这几个模块导入的别名**——同一文件里 `genome.mjs` 和
 * `genome-growth.mjs` 都有 promptLine，不按模块过滤就会互相顶替（判成假的接线证据）。
 */
export function importAliases(src = "", symbols = [], { modules = [] } = {}) {
  const wanted = new Set(asArray(symbols));
  const bases = new Set(asArray(modules).map((m) => path.basename(m)));
  const locals = new Map([...wanted].map((s) => [s, new Set([s])]));
  const re = /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(String(src))) !== null) {
    if (bases.size && !bases.has(path.basename(String(m[2] || "")))) continue;
    for (const raw of String(m[1] || "").split(",")) {
      const clause = raw.trim();
      if (!clause) continue;
      const alias = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
      if (alias) {
        if (locals.has(alias[1])) locals.get(alias[1]).add(alias[2]);
      } else if (locals.has(clause)) {
        locals.get(clause).add(clause);
      }
    }
  }
  return locals;
}

/**
 * 把 import / `export {…} from` 语句整段涂成空格（保留行号）。
 * 为什么要按行扫：多行 import 的续行（`  classifyFailure, …`）看着就像一次调用，
 * 只判首行的 `^import` 会把它们当成调用点——正是要抓的"假接线"。
 * 语句首行用 `import` + 空白/`{`/`*`/引号 识别，避开动态 `import(`。
 */
export function blankImportStatements(src = "") {
  const lines = String(src).split(/\r?\n/);
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    const blank = () => { lines[i] = " ".repeat(line.length); };
    const hasFrom = /\bfrom\s*["'][^"']*["']/.test(t);
    if (!inBlock) {
      if (/^import[\s{*'"]/.test(t)) {
        const endsHere = hasFrom || /^import\s*["']/.test(t);
        blank();
        if (!endsHere) inBlock = true;
        continue;
      }
      if (/^export\s*(\{|\*)/.test(t)) {
        blank();
        if (!hasFrom) inBlock = true;
        continue;
      }
      continue;
    }
    blank();
    if (hasFrom) inBlock = false;
  }
  return lines.join("\n");
}

const fileExists = (root, rel) => {
  try { return fs.statSync(path.join(root, rel)).isFile(); } catch { return false; }
};

const readText = (root, rel) => {
  try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch { return null; }
};

// import() 结果按绝对路径缓存：同一模块只真导一次；失败也缓存，别为每个符号重试。
const moduleCache = new Map();
async function importModule(abs) {
  if (moduleCache.has(abs)) return moduleCache.get(abs);
  let out;
  try {
    out = { ok: true, mod: await import(pathToFileURL(abs).href) };
  } catch (e) {
    out = { ok: false, error: String((e && (e.code || e.message)) || e).slice(0, 240) };
  }
  moduleCache.set(abs, out);
  return out;
}

/**
 * 在调用点文件里找声明符号（含 import 别名）。排除注释、字符串、import/export-from 行。
 * @returns {{hits: Array, missing: string[]}}
 */
export function scanCallSites({ repoRoot, callSites = [], symbols = [], modules = [] }) {
  const hits = [];
  const missing = [];
  const wanted = asArray(symbols);
  for (const rel of asArray(callSites)) {
    if (isTestPath(rel)) continue; // 测试里的调用不算"接上了"
    const abs = path.join(repoRoot, rel);
    let raw;
    try { raw = fs.readFileSync(abs, "utf8"); } catch { missing.push(rel); continue; }
    const codeLines = stripNonCode(blankImportStatements(raw)).split(/\r?\n/);
    const rawLines = raw.split(/\r?\n/);
    const aliases = importAliases(raw, wanted, { modules });
    for (let i = 0; i < codeLines.length; i += 1) {
      const line = codeLines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      // import / `export {…} from` 不是调用点；但 `export const x = fn()` 是真调用，不能一律跳
      if (/^import\b/.test(trimmed)) continue;
      if (/^export\s*(\{|\*)/.test(trimmed)) continue;
      if (/^\}?\s*from\s*["';]/.test(trimmed)) continue;
      for (const sym of wanted) {
        const names = aliases.get(sym) || new Set([sym]);
        let matched = "";
        for (const name of names) {
          if (new RegExp(`\\b${escRe(name)}\\b`).test(line)) { matched = name; break; }
        }
        if (!matched) continue;
        hits.push({ symbol: sym, name: matched, file: rel, line: i + 1, text: String(rawLines[i] || "").trim().slice(0, 160) });
      }
    }
  }
  return { hits, missing };
}

/** 开关探测：在声明文件 + 调用点 + server/config/.env 里找这个开关的痕迹。 */
function probeSwitch(sw, { root, sources }) {
  const kind = String((sw && sw.kind) || "").trim();
  if (!SWITCH_KINDS.includes(kind)) return { ok: false, reason: `不认识的开关类型「${kind || "空"}」` };

  if (kind === "gate") {
    const rel = String(sw.path || sw.name || "").trim();
    if (!rel) return { ok: false, reason: "闸文件缺 path" };
    if (fileExists(root, rel)) return { ok: true, evidence: `闸文件 ${rel}（存在）` };
    // 闸文件一般是运行时才建（不存在很正常），认代码里的引用：常量路径、读闸函数都算
    const base = path.basename(rel);
    const hit = grepSources(sources, base);
    if (hit) return { ok: true, evidence: `闸文件 ${rel}（代码引用 ${hit.file}:${hit.line}）` };
    return { ok: false, reason: `闸文件 ${rel} 既不存在也没被代码引用` };
  }

  const label = { env: "环境变量", config: "配置键", route: "API 路由", flag: "CLI 开关" }[kind];
  const needle = kind === "env" ? sw.name : kind === "config" ? sw.key : kind === "route" ? sw.path : sw.flag;
  if (!needle) return { ok: false, reason: `${label}缺名称` };
  const hit = grepSources(sources, String(needle));
  if (!hit) return { ok: false, reason: `${label} ${needle} 在源码/配置里没找到` };
  return { ok: true, evidence: `${label} ${needle}（${hit.file}:${hit.line}）` };
}

function grepSources(sources = [], needle = "") {
  if (!needle) return null;
  for (const src of sources) {
    // keepStrings：路由、环境变量名本来就写在字符串里；注释仍然剔掉（注释掉的开关不算）
    const code = stripNonCode(src.text, { keepStrings: true }).split(/\r?\n/);
    for (let i = 0; i < code.length; i += 1) {
      if (!code[i].includes(needle)) continue;
      return { file: src.rel, line: i + 1 };
    }
  }
  return null;
}

function collectSources({ root, specsFiles = [], callSites = [], switchFiles = [] }) {
  const rels = [...new Set([...specsFiles, ...callSites, ...switchFiles])];
  const out = [];
  for (const rel of rels) {
    if (!rel || isTestPath(rel)) continue;
    const text = readText(root, rel);
    if (text === null) continue;
    out.push({ rel, text });
  }
  return out;
}

/**
 * 判一项能力。
 * @param {object} spec {id,name,files,exports,tests,callSites,switches,constants?,wired?}
 * @param {{repoRoot?: string, switchFiles?: string[]}} opts
 * @returns {Promise<{id:string,name:string,level:string,evidence:string[],gaps:string[]}>}
 */
export async function gradeCapability(spec = {}, { repoRoot = process.cwd(), switchFiles = DEFAULT_SWITCH_FILES } = {}) {
  if (!spec || typeof spec !== "object") throw new TypeError("spec 必须是对象");
  const id = String(spec.id || "").trim();
  if (!id) throw new TypeError("spec.id 必填（表里得有名字）");
  const name = String(spec.name || id).trim() || id;
  const root = path.resolve(String(repoRoot || process.cwd()));

  const files = asArray(spec.files);
  const wanted = asArray(spec.exports);
  const tests = asArray(spec.tests);
  const callSites = asArray(spec.callSites);
  const switches = Array.isArray(spec.switches) ? spec.switches.filter(Boolean) : [];

  const evidence = [];
  const gaps = [];
  const done = (level) => ({ id, name, level, evidence, gaps });

  // 清单作者留下的备注进 evidence（不参与判级）：比如"同模块另一半已接"这种需要人读的话
  if (typeof spec.note === "string" && spec.note.trim()) evidence.push(`备注：${spec.note.trim()}`);

  // ── ① defined：声明的文件存在 ──
  const existing = files.filter((rel) => fileExists(root, rel));
  const constants = Array.isArray(spec.constants) ? spec.constants.filter((c) => c && c.file && c.name) : [];
  const constantHits = constants
    .filter((c) => {
      const src = readText(root, c.file);
      return !!src && new RegExp(`\\b${escRe(c.name)}\\b`).test(src);
    })
    .map((c) => `${c.file}#${c.name}`);

  if (!existing.length && !constantHits.length) {
    gaps.push(files.length || constants.length
      ? `声明文件都不存在：${briefList([...files, ...constants.map((c) => c.file)])}`
      : "没有声明任何文件（spec.files 为空）");
    return done(MISSING_LEVEL);
  }
  evidence.push(`文件存在：${briefList(existing)}`);
  if (constantHits.length) evidence.push(`常量存在：${briefList(constantHits)}`);

  // ── ② implemented：导出拿得到 + 测试文件存在 ──
  const importErrors = [];
  const missingSymbols = [];
  for (const sym of wanted) {
    let found = false;
    for (const rel of existing) {
      const loaded = await importModule(path.join(root, rel));
      if (!loaded.ok) {
        const msg = `${rel}（${loaded.error}）`;
        if (!importErrors.includes(msg)) importErrors.push(msg);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(loaded.mod, sym)) { found = true; break; }
    }
    if (!found) missingSymbols.push(sym);
  }

  const missingTests = tests.filter((rel) => !fileExists(root, rel));
  const implProblems = [];
  if (!wanted.length) implProblems.push("没有声明导出（spec.exports 为空）");
  if (missingSymbols.length) implProblems.push(`导出缺失：${briefList(missingSymbols)}`);
  if (importErrors.length) implProblems.push(`模块导入失败：${briefList(importErrors)}`);
  if (!tests.length) implProblems.push("没有声明测试文件（spec.tests 为空）");
  else if (missingTests.length === tests.length) implProblems.push(`测试文件不存在：${briefList(missingTests)}`);
  if (implProblems.length) {
    gaps.push(...implProblems);
    return done("defined");
  }
  evidence.push(`导出可 import：${briefList(wanted)}`);
  evidence.push(`测试存在：${briefList(tests)}`);

  // ── ③ integrated：非测试代码里真有调用点（或自定义断言） ──
  let wiredOk = false;
  let wiredDetail = "";
  if (typeof spec.wired === "function") {
    try {
      const out = await spec.wired({
        repoRoot: root, spec,
        readText: (rel) => readText(root, rel),
        exists: (rel) => fileExists(root, rel),
      });
      if (out === true) { wiredOk = true; wiredDetail = "spec.wired 通过"; }
      else if (out && typeof out === "object") {
        wiredOk = out.ok === true;
        wiredDetail = String(out.evidence || (wiredOk ? "spec.wired 通过" : out.gap || ""));
      }
      if (wiredOk) evidence.push(`接线断言：${wiredDetail || "spec.wired 通过"}`);
      else gaps.push(`接线断言未通过${wiredDetail ? `：${wiredDetail}` : ""}`);
    } catch (e) {
      gaps.push(`接线断言抛错：${String((e && e.message) || e).slice(0, 160)}`);
    }
  }

  if (!wiredOk) {
    const { hits, missing } = scanCallSites({ repoRoot: root, callSites, symbols: wanted, modules: files });
    if (hits.length) {
      const firstBySymbol = new Map();
      for (const h of hits) if (!firstBySymbol.has(h.symbol)) firstBySymbol.set(h.symbol, h);
      const shown = [...firstBySymbol.values()].slice(0, 3)
        .map((h) => `${h.file}:${h.line} ${h.name}${h.name === h.symbol ? "" : `（${h.symbol}）`}`);
      evidence.push(`调用点：${shown.join("；")}`);
      // 调用点全在 scripts/ 里：脚本没人跑就等于没接上，但这是"提醒"不是判级依据
      if (!spec.allowScriptOnly && hits.every((h) => /^(scripts|bin)[\\/]/i.test(h.file))) {
        gaps.push("提醒：只有脚本调用，没有运行时接线");
      }
      wiredOk = true;
    } else if (!callSites.length) {
      gaps.push("没有声明调用点（spec.callSites 为空）");
    } else if (missing.length && missing.length === callSites.length) {
      evidence.push(`已查调用点：${briefList(callSites)}（文件都不存在）`);
      gaps.push(`调用点文件不存在：${briefList(missing)}`);
    } else {
      const shown = wanted.slice(0, 2).join("、");
      evidence.push(`已查调用点：${briefList(callSites)}（${briefList(wanted)}都没出现）`);
      gaps.push(`implemented 但无调用点（${shown}）`);
    }
  }
  if (!wiredOk) return done("implemented");

  // ── ④ controllable：开关 / 闸 / 可查状态 ──
  if (!switches.length) {
    gaps.push("无开关/闸/可查状态");
    return done("integrated");
  }
  const sources = collectSources({
    root,
    specsFiles: files,
    callSites,
    switchFiles: [...asArray(spec.switchFiles), ...asArray(switchFiles)],
  });
  const okSwitches = [];
  const failedSwitches = [];
  for (const sw of switches) {
    const probe = probeSwitch(sw, { root, sources });
    if (probe.ok) okSwitches.push(probe.evidence);
    else failedSwitches.push(probe.reason);
  }
  if (!okSwitches.length) {
    gaps.push(`开关都不成立：${briefList(failedSwitches)}`);
    return done("integrated");
  }
  evidence.push(`开关：${okSwitches.join("；")}`);
  return done("controllable");
}

/** 批量判。顺序即清单顺序（表要稳定，别按耗时排）。 */
export async function gradeAll(specs = [], opts = {}) {
  const out = [];
  for (const spec of Array.isArray(specs) ? specs : []) out.push(await gradeCapability(spec, opts));
  return out;
}

/** 汇总成一行：`18 项：11 controllable / 6 integrated / …`。没有的档不写，免得一串 0 干扰。 */
export function summarize(results = []) {
  const counts = { controllable: 0, integrated: 0, implemented: 0, defined: 0, missing: 0 };
  for (const r of results) {
    const lv = String((r && r.level) || "");
    if (Object.prototype.hasOwnProperty.call(counts, lv)) counts[lv] += 1;
  }
  const order = ["controllable", "integrated", "implemented", "defined", "missing"];
  const parts = order.filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`);
  return {
    total: results.length,
    counts,
    line: `${results.length} 项：${parts.join(" / ") || "没有能力"}`,
    // implemented = 写了、导出也在、但没人调用（最该修的假活）；missing = 表里声明了、盘上没有
    fakeLive: results.filter((r) => r.level === "implemented"),
    missing: results.filter((r) => r.level === MISSING_LEVEL),
  };
}

/** 退出码：2 = 有假活（implemented）或声明落空（missing）；0 = 其余。 */
export function exitCodeFor(input) {
  const summary = Array.isArray(input) ? summarize(input) : (input && input.counts ? input : summarize([]));
  const c = summary.counts || {};
  return (c.implemented || 0) + (c.missing || 0) > 0 ? 2 : 0;
}

// 中文按 2 列宽算，不然表格会歪
function charWidth(ch) {
  return /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
}
const width = (s) => Array.from(String(s)).reduce((n, ch) => n + charWidth(ch), 0);
const pad = (s, w) => String(s) + " ".repeat(Math.max(0, w - width(s)));

/** 四格进度：✓ 已达成 / ✗ 断在这一级 / · 没走到。 */
export function levelBar(level = "") {
  const lv = String(level);
  if (lv === "controllable") return "✓✓✓✓";
  const idx = LEVELS.indexOf(lv);
  if (idx < 0) return "✗···"; // missing：连 defined 都没到
  let out = "";
  for (let i = 0; i < LEVELS.length; i += 1) {
    if (i <= idx) out += "✓";
    else if (i === idx + 1) out += "✗";
    else out += "·";
  }
  return out;
}

function wrapText(text, maxWidth = GAP_WRAP) {
  const out = [];
  let line = "";
  let used = 0;
  for (const ch of String(text)) {
    const w = charWidth(ch);
    if (used + w > maxWidth && line) { out.push(line); line = ""; used = 0; }
    line += ch;
    used += w;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

/** 缺口折行：先按「；」分段，段内再折。别在"无开关/闸"这种短语中间断行。 */
function wrapGap(text, maxWidth = GAP_WRAP) {
  const segments = String(text).split("；").map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return ["—"];
  const lines = [];
  for (const seg of segments) {
    for (const part of wrapText(seg, maxWidth)) {
      const last = lines[lines.length - 1];
      if (last !== undefined && width(last) + 1 + width(part) <= maxWidth) {
        lines[lines.length - 1] = `${last}；${part}`;
      } else {
        lines.push(part);
      }
    }
  }
  return lines;
}

/** 能力 / 等级 / 缺口。缺口太长就折行，别让表横着跑出屏幕。 */
export function renderTable(results = []) {
  const rows = (Array.isArray(results) ? results : []).map((r) => ({
    name: String(r.name || r.id || ""),
    level: `${levelBar(r.level)} ${r.level || ""}`.trim(),
    gaps: Array.isArray(r.gaps) && r.gaps.length ? r.gaps.join("；") : "—",
  }));
  const gapLines = rows.map((r) => wrapGap(r.gaps));
  const widths = [
    Math.max(width("能力"), ...rows.map((r) => width(r.name))),
    Math.max(width("等级"), ...rows.map((r) => width(r.level))),
    Math.max(width("缺口"), ...gapLines.flat().map((l) => width(l))),
  ];
  const line = (cells) => cells.map((c, k) => pad(c ?? "", widths[k])).join("  ").trimEnd();
  const out = [line(["能力", "等级", "缺口"]), widths.map((w) => "─".repeat(w)).join("  ")];
  rows.forEach((row, idx) => {
    const wraps = gapLines[idx];
    out.push(line([row.name, row.level, wraps[0]]));
    for (const cont of wraps.slice(1)) out.push(line(["", "", cont]));
  });
  return out.join("\n");
}

/** 表下面那段：没接上的单独点名，别让人自己去表里找。 */
export function renderFindings(summary = {}) {
  const out = [];
  if (summary.fakeLive && summary.fakeLive.length) {
    out.push("写了但没接（implemented 但未 integrated，这是最该修的假活）：");
    for (const r of summary.fakeLive) out.push(`  ⚠ ${r.name}（${r.id}）— ${r.gaps.join("；")}`);
  }
  if (summary.missing && summary.missing.length) {
    out.push("声明落空（表里写了、盘上没有）：");
    for (const r of summary.missing) out.push(`  ✖ ${r.name}（${r.id}）— ${r.gaps.join("；")}`);
  }
  return out.join("\n");
}
