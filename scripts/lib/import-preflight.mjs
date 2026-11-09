// 部署前"符号级"导入预检。
//
// 为什么需要它（2026-11-10 真事故）：
//   1) ERR_MODULE_NOT_FOUND：装包时忘记拷贝某个模块；
//   2) SyntaxError: './engine/failure-ledger.mjs' does not provide an export named
//      'failureAttribution'：导入方写了一个目标文件根本没导出的名字，服务起来就崩。
// 现有 predeploy-check 只查语法与文件存在，查不出第 2 类。
//
// 做法：
//   - 从 entry 出发，递归收集所有本地相对导入（./、../）；node: 与第三方裸导入跳过。
//   - 对每个目标文件：存在性 → import() 真加载（URL 带内容 hash 破缓存）→
//     用运行时命名空间比对"被具名导入的符号"是否真的导出。
//   - default / namespace / `export *` / 动态导入不做具名断言，记在 unknowns 里（防误报）。
//   - 任何异常都不外抛，统一变成 issues。
//
// 局限（务必知道）：
//   - import() 会真实执行目标模块的顶层代码（连库、起定时器、读配置）。预检不等同"纯静态"。
//   - 入口自身不加载（避免把 server.mjs 跑第二遍），只解析；所以 entry 顶层错误查不到。
//   - 只能证明"模块能加载 + 名字存在"，证明不了运行时逻辑、环境变量、数据依赖。
//
// 返回：
//   { ok, checked, issues, timedOut, unknowns }
//   checked  = 实际做了"存在性 + 加载"的目标文件数（不含 entry）
//   issues[] = { kind:'missing-file'|'missing-export'|'load-error', from, target, symbols, hint }
//   unknowns[] = { from, target, symbols, reason }  // 无法静态断言、但不算失败的边
//   ok = issues 为空且未超时
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const LOCAL_SPEC = /^\.\.?\//;
const isLocalSpec = (spec) => typeof spec === "string" && LOCAL_SPEC.test(spec);

// 只认常见 ESM 静态写法；够覆盖本仓库（.mjs + 具名导入为主）。
const RE_NAMED_IMPORT =
  /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const RE_NAMESPACE_IMPORT =
  /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\*\s*as\s+[A-Za-z_$][\w$]*\s+from\s*["']([^"']+)["']/g;
const RE_DEFAULT_IMPORT =
  /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s*["']([^"']+)["']/g;
const RE_BARE_IMPORT = /import\s*["']([^"']+)["']/g;
const RE_EXPORT_NAMED_FROM =
  /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const RE_EXPORT_STAR_FROM =
  /export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s*["']([^"']+)["']/g;
const RE_DYNAMIC_IMPORT = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** 去掉注释但保留字符串内容（避免把注释里的 import 当成真导入）。 */
function stripComments(source) {
  const src = String(source ?? "");
  let out = "";
  let state = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") {
        state = "line";
        out += "  ";
        i++;
        continue;
      }
      if (c === "/" && d === "*") {
        state = "block";
        out += "  ";
        i++;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        state = c === "'" ? "sq" : c === '"' ? "dq" : "tpl";
      }
      out += c;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else out += " ";
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        state = "code";
        out += "  ";
        i++;
      } else out += c === "\n" ? "\n" : " ";
      continue;
    }
    // 字符串 / 模板字符串：原样保留
    out += c;
    if (c === "\\" && i + 1 < src.length) {
      out += src[i + 1];
      i++;
      continue;
    }
    if (
      (state === "sq" && c === "'") ||
      (state === "dq" && c === '"') ||
      (state === "tpl" && c === "`")
    ) {
      state = "code";
    }
  }
  return out;
}

/** `{ a, b as c, type D }` → ['a','b']（取原始导出名，不取本地别名）。 */
function parseSymbolList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^type\s+/.test(s))
    .map((s) => s.split(/\s+as\s+/)[0].trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

/** 解析一个模块源码里的本地相对导入边。 */
function collectEdges(source) {
  const code = stripComments(source);
  const edges = new Map(); // cleanSpec -> { symbols:Set, unknownReasons:Set }
  const add = (spec, symbols = [], unknown = "") => {
    if (!isLocalSpec(spec)) return;
    const clean = spec.split(/[?#]/)[0];
    if (!clean) return;
    let e = edges.get(clean);
    if (!e) {
      e = { spec: clean, symbols: new Set(), unknownReasons: new Set() };
      edges.set(clean, e);
    }
    for (const s of symbols) e.symbols.add(s);
    if (unknown) e.unknownReasons.add(unknown);
  };

  for (const m of code.matchAll(RE_NAMED_IMPORT)) add(m[2], parseSymbolList(m[1]));
  for (const m of code.matchAll(RE_NAMESPACE_IMPORT)) add(m[1], [], "namespace 导入");
  for (const m of code.matchAll(RE_DEFAULT_IMPORT)) add(m[2], [], "default 导入");
  for (const m of code.matchAll(RE_BARE_IMPORT)) add(m[1], []);
  for (const m of code.matchAll(RE_EXPORT_NAMED_FROM)) add(m[2], parseSymbolList(m[1]));
  for (const m of code.matchAll(RE_EXPORT_STAR_FROM)) add(m[1], [], "export *");
  for (const m of code.matchAll(RE_DYNAMIC_IMPORT)) add(m[1], [], "动态 import");
  return [...edges.values()];
}

/** 解析目标文件；扩展名可省略。找不到返回 null。 */
function resolveLocal(importerAbs, spec) {
  const clean = spec.split(/[?#]/)[0];
  if (!clean) return null;
  const base = path.resolve(path.dirname(importerAbs), clean);
  const candidates = [base];
  if (!path.extname(base)) {
    for (const ext of [".mjs", ".js", ".cjs", ".json"]) candidates.push(base + ext);
    for (const idx of ["index.mjs", "index.js", "index.cjs"]) candidates.push(path.join(base, idx));
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续试下一个候选 */
    }
  }
  return null;
}

function oneLine(value, max = 300) {
  return String(value ?? "")
    .split(/\r?\n/)[0]
    .trim()
    .slice(0, max);
}

/** import() 带超时；超时用 code 区分，且吞掉后续 rejection 防止 unhandled。 */
function importWithTimeout(fileUrl, remainingMs) {
  const pending = import(fileUrl);
  pending.catch(() => {});
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    const err = new Error("import() 超出时间预算，未加载");
    err.code = "PREFLIGHT_TIMEOUT";
    return Promise.reject(err);
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`import() 超时（>${Math.round(remainingMs)}ms）`);
      err.code = "PREFLIGHT_TIMEOUT";
      reject(err);
    }, remainingMs);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 部署前导入预检。
 * @param {{root?: string, entry?: string, timeoutMs?: number}} opts
 * @returns {Promise<{ok:boolean, checked:number, issues:Array, timedOut:boolean, unknowns:Array}>}
 */
export async function preflightImports({ root, entry = "server.mjs", timeoutMs = 60000 } = {}) {
  const issues = [];
  const unknowns = [];
  const seenIssue = new Set();
  let checked = 0;
  let timedOut = false;
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
  const deadline = Date.now() + budget;

  const pushIssue = (issue, key) => {
    if (key) {
      if (seenIssue.has(key)) return;
      seenIssue.add(key);
    }
    issues.push(issue);
  };

  try {
    const rootAbs = path.resolve(String(root ?? process.cwd()));
    const entryAbs = path.resolve(rootAbs, String(entry));
    const rel = (abs) => {
      const r = path.relative(rootAbs, abs);
      return (r || path.basename(abs) || String(abs)).split(path.sep).join("/");
    };

    // ── 0. entry 必须存在 ──
    let entryStat = null;
    try {
      entryStat = fs.statSync(entryAbs);
    } catch {}
    if (!entryStat || !entryStat.isFile()) {
      pushIssue(
        {
          kind: "missing-file",
          from: "",
          target: rel(entryAbs),
          symbols: [],
          hint: `entry 不存在或不是文件：${entryAbs}（检查 --root 是否指到装机目录）`,
        },
        "entry",
      );
      return { ok: false, checked, issues, timedOut, unknowns };
    }

    // ── 1. BFS 收集本地相对导入，并汇总每个目标被要求的具名符号 ──
    const seen = new Set([entryAbs]);
    const queue = [entryAbs];
    const required = new Map(); // targetAbs -> { symbols:Set, importers:Set, unknownReasons:Set }

    while (queue.length) {
      const importerAbs = queue.shift();
      let source;
      try {
        source = fs.readFileSync(importerAbs, "utf8");
      } catch (e) {
        pushIssue(
          {
            kind: "load-error",
            from: "",
            target: rel(importerAbs),
            symbols: [],
            hint: `读取源码失败：${oneLine(e?.message || e)}`,
          },
          `read:${importerAbs}`,
        );
        continue;
      }

      for (const edge of collectEdges(source)) {
        const targetAbs = resolveLocal(importerAbs, edge.spec);
        if (!targetAbs) {
          const missingAbs = path.resolve(path.dirname(importerAbs), edge.spec.split(/[?#]/)[0]);
          pushIssue(
            {
              kind: "missing-file",
              from: rel(importerAbs),
              target: rel(missingAbs),
              symbols: [...edge.symbols],
              hint: `被 ${rel(importerAbs)} 导入，但文件不存在。多半是忘拷贝/忘打包（ERR_MODULE_NOT_FOUND 那类）。`,
            },
            `mf:${missingAbs}`,
          );
          continue;
        }

        let req = required.get(targetAbs);
        if (!req) {
          req = { symbols: new Set(), importers: new Set(), unknownReasons: new Set() };
          required.set(targetAbs, req);
        }
        for (const s of edge.symbols) req.symbols.add(s);
        for (const r of edge.unknownReasons) req.unknownReasons.add(r);
        req.importers.add(rel(importerAbs));

        if (!seen.has(targetAbs)) {
          seen.add(targetAbs);
          queue.push(targetAbs);
        }
      }
    }

    // ── 2. 逐个目标：存在性 → 真加载 → 比对具名导出 ──
    const targets = [...required.keys()].sort();
    for (let idx = 0; idx < targets.length; idx++) {
      const targetAbs = targets[idx];
      const req = required.get(targetAbs);
      const importerList = [...req.importers].join(", ") || "";

      if (Date.now() >= deadline) {
        timedOut = true;
        pushIssue(
          {
            kind: "load-error",
            from: importerList,
            target: "(时间预算)",
            symbols: [],
            hint: `累计超过 ${budget}ms，剩余 ${targets.length - idx} 个文件未检查（调大 timeoutMs 或 --preflight-timeout）`,
          },
          "timeout",
        );
        break;
      }

      let stat = null;
      try {
        stat = fs.statSync(targetAbs);
      } catch {}
      if (!stat || !stat.isFile()) {
        pushIssue(
          {
            kind: "missing-file",
            from: importerList,
            target: rel(targetAbs),
            symbols: [...req.symbols],
            hint: `被 ${importerList} 导入，但文件不存在。`,
          },
          `mf:${targetAbs}`,
        );
        continue;
      }

      checked++;
      const ext = path.extname(targetAbs).toLowerCase();
      if (ext === ".json") {
        unknowns.push({
          from: importerList,
          target: rel(targetAbs),
          symbols: [],
          reason: "JSON 模块，只查存在性，不做符号断言",
        });
        continue;
      }
      if (![".mjs", ".js", ".cjs"].includes(ext)) {
        unknowns.push({
          from: importerList,
          target: rel(targetAbs),
          symbols: [],
          reason: `非 JS 模块（${ext || "无扩展名"}），只查存在性`,
        });
        continue;
      }

      let fileUrl;
      try {
        const digest = crypto.createHash("sha1").update(fs.readFileSync(targetAbs)).digest("hex");
        fileUrl = `${pathToFileURL(targetAbs).href}?v=${digest.slice(0, 12)}`;
      } catch (e) {
        pushIssue(
          {
            kind: "load-error",
            from: importerList,
            target: rel(targetAbs),
            symbols: [...req.symbols],
            hint: `读取/哈希失败：${oneLine(e?.message || e)}`,
          },
          `hash:${targetAbs}`,
        );
        continue;
      }

      let ns = null;
      try {
        ns = await importWithTimeout(fileUrl, deadline - Date.now());
      } catch (e) {
        if (e?.code === "PREFLIGHT_TIMEOUT") timedOut = true;
        pushIssue(
          {
            kind: "load-error",
            from: importerList,
            target: rel(targetAbs),
            symbols: [...req.symbols],
            hint: `import() 失败：${oneLine(e?.message || e)}${e?.code === "PREFLIGHT_TIMEOUT" ? "（超时）" : ""}`,
          },
          `le:${targetAbs}`,
        );
        if (timedOut) break;
        continue;
      }

      const exported = new Set(Object.keys(ns || {}));
      const missing = [...req.symbols].filter((sym) => !exported.has(sym));
      if (missing.length) {
        pushIssue(
          {
            kind: "missing-export",
            from: importerList,
            target: rel(targetAbs),
            symbols: missing,
            hint: `${rel(targetAbs)} 没有导出 ${missing.join(", ")}；导入方（${importerList}）启动时会报 "does not provide an export named …"。`,
          },
          `me:${targetAbs}`,
        );
      }
    }

    // ── 3. 无法具名断言、但不算失败的边，显式标 unknown ──
    for (const targetAbs of targets) {
      const req = required.get(targetAbs);
      if (!req || req.unknownReasons.size === 0) continue;
      unknowns.push({
        from: [...req.importers][0] || "",
        target: rel(targetAbs),
        symbols: [],
        reason: [...req.unknownReasons].join(" / "),
      });
    }

    return { ok: issues.length === 0 && !timedOut, checked, issues, timedOut, unknowns };
  } catch (e) {
    // 预检自身坏了也不能把部署脚本带崩，更不能误判为"通过"
    issues.push({
      kind: "load-error",
      from: "",
      target: String(entry ?? "server.mjs"),
      symbols: [],
      hint: `预检自身异常：${oneLine(e?.message || e)}`,
    });
    return { ok: false, checked, issues, timedOut, unknowns };
  }
}
