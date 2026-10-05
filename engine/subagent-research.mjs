// 只读研究员的工具箱：子智能体自己去读、去查，而不是等主代理把材料嚼碎了喂过来。
//
// 2026-10-05 诊断：元枢 1856 条用户消息里 delegate_task 只被调了 13 次——子智能体只有
// 文本分析能力，主代理想委派得先自己把文件读完再转述，委派比自己干还费事。对照组 pi CLI
// 里能读能跑的子智能体同一个人用了 251 次。所以这里给它**有界的只读**能力：
//   · 只有 read / list / grep / web_search 四个工具，没有写、没有命令；
//   · 文件只在 roots（工作区）内，凭据文件一律不见，输出过一遍脱敏；
//   · 每次工具输出有上限，整轮步数由 spawnSubagent 控制。
import fs from "node:fs";
import path from "node:path";
import { isSensitivePath, redactSecrets } from "./tools/secrets-guard.mjs";

export const RESEARCH_MAX_STEPS = 8;
const MAX_OUTPUT = 8000;
const MAX_READ_LINES = 400;
const MAX_LIST = 200;
const MAX_GREP_FILES = 3000;
const MAX_GREP_HITS = 60;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".cache"]);
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico", ".pdf", ".zip", ".gz", ".7z", ".mp3", ".mp4", ".wav", ".webm", ".exe", ".dll", ".onnx", ".bin", ".pt", ".pth", ".safetensors", ".ttf", ".woff", ".woff2", ".xlsx", ".docx", ".pptx", ".sqlite", ".db"]);

const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
export const RESEARCH_TOOLS = [
  fn("read", "读文本文件（工作区相对路径或工作区内绝对路径）。大文件用 offset/limit 分段读，单次最多 400 行。", {
    path: { type: "string" }, offset: { type: "number", description: "起始行，1 开始" }, limit: { type: "number", description: "行数，默认 200" },
  }, ["path"]),
  fn("list", "列目录（最多 200 项，目录名后带 /）。", { path: { type: "string", description: "目录，默认工作区根" } }, []),
  fn("grep", "在目录里按正则搜文本，返回 文件:行号:内容（最多 60 条）。自动跳过 node_modules/.git/dist 与二进制文件。", {
    pattern: { type: "string" }, path: { type: "string", description: "目录或文件，默认工作区根" }, glob: { type: "string", description: "文件名过滤，如 *.mjs" },
  }, ["pattern"]),
  fn("web_search", "联网搜索，返回前 5 条标题/链接/摘要。", { query: { type: "string" } }, ["query"]),
];
export const RESEARCH_TOOL_NAMES = RESEARCH_TOOLS.map(t => t.function.name);

const clip = (text) => {
  const s = redactSecrets(String(text ?? ""));
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（输出超过 ${MAX_OUTPUT} 字符已截断，请缩小范围）` : s;
};
const fail = (text) => ({ text, isError: true });

/** 把模型给的路径解析到某个 root 内；越界、凭据文件返回 null。 */
export function resolveInRoots(roots, p) {
  const list = roots.map(r => path.resolve(r));
  const raw = String(p || "").trim() || ".";
  const candidates = path.isAbsolute(raw) ? [path.resolve(raw)] : list.map(r => path.resolve(r, raw));
  for (const abs of candidates) {
    const root = list.find(r => abs === r || abs.toLowerCase().startsWith((r + path.sep).toLowerCase()));
    if (!root) continue;
    if (isSensitivePath(abs)) return null;
    try {
      if (fs.existsSync(abs)) {
        const real = fs.realpathSync(abs);
        const realRoot = fs.realpathSync(root);
        if (real !== realRoot && !real.toLowerCase().startsWith((realRoot + path.sep).toLowerCase())) continue;
      }
    } catch { continue; }
    return abs;
  }
  return null;
}

function globToRegExp(glob) {
  if (!glob) return null;
  const body = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

function* walkFiles(start, budget) {
  const stack = [start];
  while (stack.length && budget.files < MAX_GREP_FILES) {
    const cur = stack.pop();
    let st; try { st = fs.statSync(cur); } catch { continue; }
    if (st.isFile()) { budget.files++; yield cur; continue; }
    if (!st.isDirectory()) continue;
    let entries = []; try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith("."))) continue;
      stack.push(path.join(cur, e.name));
    }
  }
}

export function createResearchExecutor({ roots = [], webSearch = null } = {}) {
  // roots 可以是数组或返回数组的函数（工作区根在服务初始化后才定，按调用时取值）
  let usable = [];
  const rel = (abs) => {
    const root = usable.map(r => path.resolve(r)).find(r => abs.toLowerCase().startsWith(r.toLowerCase()));
    return root ? path.relative(root, abs).replace(/\\/g, "/") || "." : abs;
  };
  return async function executeResearchTool(name, args = {}) {
    try {
      usable = [...new Set((typeof roots === "function" ? roots() : roots) || [])].filter(Boolean);
      if (!usable.length && name !== "web_search") return fail("研究员没有可读目录");
      if (name === "read") {
        const p = resolveInRoots(usable, args.path);
        if (!p) return fail(`不可读：${args.path}（只能读工作区内的非凭据文件）`);
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return fail(`文件不存在：${args.path}`);
        if (BINARY_EXT.has(path.extname(p).toLowerCase())) return fail(`二进制文件不按文本读取：${args.path}`);
        const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
        const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
        const limit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(Number(args.limit) || 200)));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const more = offset - 1 + limit < lines.length ? `\n…（共 ${lines.length} 行，后续用 offset=${offset + limit} 继续）` : "";
        return { text: clip(slice.map((l, i) => `${offset + i}: ${l}`).join("\n") + more) };
      }
      if (name === "list") {
        const p = resolveInRoots(usable, args.path || ".");
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return fail(`目录不可读：${args.path || "."}`);
        const entries = fs.readdirSync(p, { withFileTypes: true }).filter(e => !isSensitivePath(path.join(p, e.name)));
        const shown = entries.slice(0, MAX_LIST).map(e => e.isDirectory() ? `${e.name}/` : e.name);
        return { text: clip(`${rel(p)}（${entries.length} 项）\n${shown.join("\n")}${entries.length > MAX_LIST ? "\n…" : ""}`) };
      }
      if (name === "grep") {
        let re;
        try { re = new RegExp(String(args.pattern || ""), "i"); } catch { re = new RegExp(String(args.pattern || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
        if (!args.pattern) return fail("grep 需要 pattern");
        const start = resolveInRoots(usable, args.path || ".");
        if (!start || !fs.existsSync(start)) return fail(`搜索范围不可读：${args.path || "."}`);
        const only = globToRegExp(args.glob);
        const budget = { files: 0 };
        const hits = [];
        for (const file of walkFiles(start, budget)) {
          if (hits.length >= MAX_GREP_HITS) break;
          if (BINARY_EXT.has(path.extname(file).toLowerCase()) || isSensitivePath(file)) continue;
          if (only && !only.test(path.basename(file))) continue;
          let st; try { st = fs.statSync(file); } catch { continue; }
          if (st.size > 2 * 1024 * 1024) continue;
          let text; try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < MAX_GREP_HITS; i++) {
            if (re.test(lines[i])) hits.push(`${rel(file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
        const tail = hits.length >= MAX_GREP_HITS ? `\n…（命中超过 ${MAX_GREP_HITS} 条，请缩小范围）` : budget.files >= MAX_GREP_FILES ? `\n…（扫描到 ${MAX_GREP_FILES} 个文件上限，请缩小目录）` : "";
        return { text: clip(hits.length ? hits.join("\n") + tail : `无匹配（扫描 ${budget.files} 个文件）`) };
      }
      if (name === "web_search") {
        if (typeof webSearch !== "function") return fail("联网搜索未接入");
        const r = String(await webSearch(String(args.query || "").slice(0, 200)));
        return { text: clip(r), isError: r.startsWith("（搜索") };
      }
      return fail(`研究员没有这个工具：${name}（只有 ${RESEARCH_TOOL_NAMES.join(" / ")}）`);
    } catch (e) {
      return fail(`工具执行失败：${String(e?.message || e).slice(0, 200)}`);
    }
  };
}
