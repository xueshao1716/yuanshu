// ══ 小说工坊·书架式创作系统 ══
// 数据：PI_NOVELS_DIR（否则 WS_ROOT/novels）每本书：meta + layers/ + truth/ + chapters/
// 写作：agent 管道 + novel-forge-v10；按管道节点推进，作品永久沉淀
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { WS_ROOT } from "./workspace-api.mjs";
import { PIPELINE_NODES, findNode, nodeTemplate, isNodeReady } from "./workshop-novel-nodes.mjs";

export { PIPELINE_NODES, findNode };

export function resolveNovelsDir({ env = process.env, wsRoot = WS_ROOT } = {}) {
  if (env.PI_NOVELS_DIR) return env.PI_NOVELS_DIR;
  if (wsRoot) return path.join(wsRoot, "novels");
  return path.join(os.homedir(), "pi-workspace", "novels");
}

export function novelsDir() {
  return resolveNovelsDir();
}

const GENRES = ["xianxia", "urban", "scifi", "history", "mystery", "horror"];
const STATUSES = ["draft", "building", "writing", "revising", "archived"];

export function safeId(id) {
  const s = String(id || "");
  return /^[\w\u4e00-\u9fff-]{1,80}$/.test(s) ? s : "";
}
function safeName(n) {
  return String(n || "").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "未命名";
}
function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
}
function inside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}
function bookDir(id, dir = novelsDir()) {
  const sid = safeId(id);
  if (!sid) return "";
  const bd = path.join(dir, sid);
  return inside(dir, bd) ? bd : "";
}

function chapterTitle(content, no) {
  const first = String(content || "").split(/\r?\n/).find(l => l.trim()) || "";
  const stripped = first.replace(/^#+\s*/, "").replace(/^第[0-9零一二三四五六七八九十百千]+章\s*/, "").trim();
  return stripped || `第${String(no).padStart(3, "0")}章`;
}

function listChapterFiles(bd) {
  const chapters = [];
  try {
    for (const f of fs.readdirSync(path.join(bd, "chapters"))) {
      const m = f.match(/^(第(\d+)章)\.md$/);
      if (!m) continue;
      const no = parseInt(m[2], 10);
      const fp = path.join(bd, "chapters", f);
      const st = fs.statSync(fp);
      const content = readFileIf(fp);
      chapters.push({ file: f, no, size: st.size, mtimeMs: st.mtimeMs, title: chapterTitle(content, no), chars: content.length });
    }
  } catch {}
  chapters.sort((a, b) => a.no - b.no);
  return chapters;
}

export function ensureBookFiles(bd, meta = {}) {
  fs.mkdirSync(path.join(bd, "chapters"), { recursive: true });
  fs.mkdirSync(path.join(bd, "layers"), { recursive: true });
  fs.mkdirSync(path.join(bd, "truth"), { recursive: true });
  fs.mkdirSync(path.join(bd, "snapshots"), { recursive: true });
  for (const node of PIPELINE_NODES) {
    if (!node.file) continue;
    const f = path.join(bd, node.file);
    if (!inside(bd, f)) continue;
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, nodeTemplate(node, meta), "utf8");
    }
  }
}

function readFileIf(f) {
  try { return fs.readFileSync(f, "utf8"); } catch { return ""; }
}

export function pipelineOf(bd, chapterCount = 0) {
  return PIPELINE_NODES.map(node => {
    const content = node.file ? readFileIf(path.join(bd, node.file)) : "";
    const ready = isNodeReady(node, content, chapterCount);
    return { id: node.id, phase: node.phase, label: node.label, kind: node.kind, generate: !!node.generate, ready, chars: content.trim().length };
  });
}

export function listBooks(dir = novelsDir()) {
  const out = [];
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const bd = path.join(dir, d.name);
      const meta = readJson(path.join(bd, "meta.json"), {});
      const chapters = listChapterFiles(bd).length;
      const pipe = pipelineOf(bd, chapters);
      out.push({
        id: d.name,
        title: meta.title || d.name,
        genre: meta.genre || "xianxia",
        protagonist: meta.protagonist || "",
        status: meta.status || "draft",
        narrator: meta.narrator || "第三人称",
        chapters,
        createdAt: meta.createdAt || "",
        pipelineReady: pipe.filter(n => n.ready).length,
        pipelineTotal: pipe.length,
      });
    }
  } catch {}
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

export function createBook(body, dir = novelsDir()) {
  const title = String(body?.title || "").trim();
  if (!title) return { error: "缺少书名" };
  const genre = GENRES.includes(body?.genre) ? body.genre : "xianxia";
  const protagonist = String(body?.protagonist || "").trim().slice(0, 200);
  const setting = String(body?.setting || "").trim().slice(0, 500);
  const narrator = String(body?.narrator || "第三人称").trim().slice(0, 12);
  const id = safeName(title) + "-" + Date.now().toString(36);
  const bd = path.join(dir, id);
  const meta = { title, genre, protagonist, setting, narrator, status: "draft", createdAt: new Date().toISOString() };
  fs.mkdirSync(bd, { recursive: true });
  fs.writeFileSync(path.join(bd, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  ensureBookFiles(bd, meta);
  return { ok: true, id, ...meta };
}

export function bookDetail(id, dir = novelsDir()) {
  const bd = bookDir(id, dir);
  if (!bd) return { error: "非法作品 id" };
  if (!fs.existsSync(bd)) return { error: "作品不存在" };
  const meta = readJson(path.join(bd, "meta.json"), {});
  ensureBookFiles(bd, meta);
  const chapters = listChapterFiles(bd);
  const pipeline = pipelineOf(bd, chapters.length);
  let truthBrief = {};
  try {
    truthBrief.canon = readFileIf(path.join(bd, "truth", "canon.md")).slice(0, 600);
    truthBrief.state = readJson(path.join(bd, "truth", "current_state.json"), {});
    truthBrief.hooks = readJson(path.join(bd, "truth", "pending_hooks.json"), []);
    truthBrief.summaries = readJson(path.join(bd, "truth", "chapter_summaries.json"), []);
  } catch {}
  const nextCh = chapters.length ? Math.max(...chapters.map(c => c.no)) + 1 : 1;
  return { id: path.basename(bd), meta, chapters, truth: truthBrief, nextCh, pipeline, notes: readFileIf(path.join(bd, "notes.md")) };
}

function chapterFile(id, file, dir) {
  const bd = bookDir(id, dir);
  const sf = /^第\d+章\.md$/.test(String(file || "")) ? String(file) : "";
  if (!bd || !sf) return { error: "非法参数" };
  const f = path.join(bd, "chapters", sf);
  if (!inside(bd, f)) return { error: "非法参数" };
  return { bd, sf, f };
}

export function readChapter(id, file, dir = novelsDir()) {
  const loc = chapterFile(id, file, dir);
  if (loc.error) return loc;
  if (!fs.existsSync(loc.f)) return { error: "章节不存在" };
  return { ok: true, file: loc.sf, content: fs.readFileSync(loc.f, "utf8") };
}

export function writeChapter(id, file, content, dir = novelsDir()) {
  const loc = chapterFile(id, file, dir);
  if (loc.error) return loc;
  if (!fs.existsSync(loc.f)) return { error: "章节不存在" };
  const text = String(content ?? "");
  if (text.length > 200_000) return { error: "内容过长" };
  fs.writeFileSync(loc.f, text, "utf8");
  return { ok: true, file: loc.sf };
}

export function readNode(id, nodeId, dir = novelsDir()) {
  const node = findNode(nodeId);
  const bd = bookDir(id, dir);
  if (!bd || !fs.existsSync(bd)) return { error: "作品不存在" };
  if (!node?.file) return { error: "该节点没有可编辑文件" };
  const f = path.join(bd, node.file);
  if (!inside(bd, f)) return { error: "非法路径" };
  return { ok: true, node: node.id, file: node.file, content: readFileIf(f) };
}

export function writeNode(id, nodeId, content, dir = novelsDir()) {
  const node = findNode(nodeId);
  const bd = bookDir(id, dir);
  if (!bd || !fs.existsSync(bd)) return { error: "作品不存在" };
  if (!node?.file) return { error: "该节点没有可编辑文件" };
  const f = path.join(bd, node.file);
  if (!inside(bd, f)) return { error: "非法路径" };
  const text = String(content ?? "");
  if (text.length > 200_000) return { error: "内容过长" };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
  return { ok: true, node: node.id, file: node.file };
}

export function updateBook(id, patch, dir = novelsDir()) {
  const bd = bookDir(id, dir);
  if (!bd || !fs.existsSync(bd)) return { error: "作品不存在" };
  const meta = readJson(path.join(bd, "meta.json"), {});
  if (patch?.title != null) {
    const title = String(patch.title).trim().slice(0, 80);
    if (!title) return { error: "缺少书名" };
    meta.title = title;
  }
  if (patch?.status != null) {
    if (!STATUSES.includes(patch.status)) return { error: "非法状态" };
    meta.status = patch.status;
  }
  if (patch?.genre != null) meta.genre = GENRES.includes(patch.genre) ? patch.genre : meta.genre;
  if (patch?.protagonist != null) meta.protagonist = String(patch.protagonist).trim().slice(0, 200);
  if (patch?.setting != null) meta.setting = String(patch.setting).trim().slice(0, 500);
  if (patch?.narrator != null) meta.narrator = String(patch.narrator).trim().slice(0, 12);
  fs.writeFileSync(path.join(bd, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return { ok: true, ...meta };
}

export function deleteBook(id, dir = novelsDir()) {
  const bd = bookDir(id, dir);
  if (!bd || !fs.existsSync(bd)) return { error: "作品不存在" };
  if (!fs.existsSync(path.join(bd, "meta.json"))) return { error: "不是作品目录" };
  fs.rmSync(bd, { recursive: true, force: true });
  return { ok: true };
}

export function exportBook(id, dir = novelsDir()) {
  const bd = bookDir(id, dir);
  if (!bd || !fs.existsSync(bd)) return { error: "作品不存在" };
  const meta = readJson(path.join(bd, "meta.json"), {});
  const chapters = listChapterFiles(bd);
  const parts = [`# 《${meta.title || id}》\n`];
  for (const c of chapters) {
    parts.push(`## 第${String(c.no).padStart(3, "0")}章\n\n` + readFileIf(path.join(bd, "chapters", c.file)).trim());
  }
  const content = parts.join("\n\n") + "\n";
  fs.writeFileSync(path.join(bd, "export.md"), content, "utf8");
  return { ok: true, content, chapters: chapters.length };
}

export function writeNotes(id, notes, dir = novelsDir()) {
  const bd = bookDir(id, dir);
  if (!bd || !fs.existsSync(bd)) return { error: "作品不存在" };
  const text = String(notes ?? "").slice(0, 8000);
  fs.writeFileSync(path.join(bd, "notes.md"), text, "utf8");
  return { ok: true };
}
