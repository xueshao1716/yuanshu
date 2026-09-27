// ══════════════════════════════════════════════════════════
// engine/gallery-core.mjs —— 作品集核心纯逻辑（2026-09-03 创作工坊产品化第一步）
// 设计：扫描式登记——任何产出（聊天/工坊）落进 workshop-out 即自动可见，零仪式感
//   scanGallery  —— 扫 workshop-out：ppthtml-*/（设计稿 deck）与 ppt-*/presentation.pptx（经典）
//   readDeck     —— 读一个 deck 的全部页面（路径限定 outRoot 内，防穿越）
// 全部注入 fsMod 便于单测（与 workshop-ppt-core.mjs 同风格）
// ══════════════════════════════════════════════════════════
import * as fs from "node:fs";
import { join, basename, sep } from "node:path";

/** 从 HTML 里提取标题：deck.json title > <h1>/<h2> 首行 > 文件名 */
function pickTitle(html, fallback) {
  const m = html.match(/<h[12][^>]*>([^<]{1,80})</);
  if (m) return m[1].trim();
  return fallback;
}

/**
 * 扫描作品集。返回 [{id, kind, dir(rel, / 分隔), title, pages, themeKey, ts, cover}]
 * - kind:'deck'  —— ppthtml-<id> 目录（deck.json 或 pages 下 html，设计稿）
 * - kind:'pptx'  —— ppt-<id> 目录内 presentation.pptx（经典）
 * 按 ts 倒序（最新在前）
 */
export function scanGallery(outRoot, fsMod = fs) {
  const items = [];
  let entries = [];
  try { entries = fsMod.readdirSync(outRoot, { withFileTypes: true }); } catch { return items; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = ent.name;
    const absDir = join(outRoot, dir);
    const rel = `${basename(outRoot)}/${dir}`.replace(/\\/g, "/");
    let st;
    try { st = fsMod.statSync(absDir); } catch { continue; }
    if (dir.startsWith("ppthtml-")) {
      // 设计稿 deck：优先 deck.json 元数据，兜底扫 pages/
      let pages = 0, title = "", themeKey = "", cover = "";
      try {
        const deckPath = join(absDir, "deck.json");
        if (fsMod.existsSync(deckPath)) {
          const deck = JSON.parse(fsMod.readFileSync(deckPath, "utf8"));
          const list = Array.isArray(deck) ? deck : deck.slides || [];
          pages = list.length;
          title = deck.metadata?.title || deck.metadata?.theme || "";
          const first = list[0];
          if (first?.file) cover = `pages/${basename(String(first.file))}`;
          if (typeof deck.metadata?.themeKey === "string") themeKey = deck.metadata.themeKey;
        }
      } catch { /* deck.json 坏了走兜底 */ }
      try {
        const pdir = join(absDir, "pages");
        const htmls = fsMod.existsSync(pdir) ? fsMod.readdirSync(pdir).filter(n => n.endsWith(".html")).sort() : [];
        if (!pages) pages = htmls.length;
        if (!cover && htmls.length) cover = `pages/${htmls[0]}`;
        if (!title && htmls.length) title = pickTitle(fsMod.readFileSync(join(pdir, htmls[0]), "utf8"), "");
      } catch { /* pages 扫描失败保持现状 */ }
      if (!pages) continue; // 空目录不算作品
      items.push({ id: dir, kind: "deck", dir: rel, title: title || dir, pages, themeKey, ts: st.mtimeMs, cover });
    } else if (dir.startsWith("ppt-")) {
      const pptx = join(absDir, "presentation.pptx");
      if (!fsMod.existsSync(pptx)) continue;
      let title = "";
      try {
        const j = findSlidesJsonIn(absDir, fsMod);
        if (j) { const d = JSON.parse(fsMod.readFileSync(j, "utf8")); title = d.metadata?.title || ""; }
      } catch { /* 忽略 */ }
      items.push({ id: dir, kind: "pptx", dir: rel, title: title || dir, pages: 0, themeKey: "", ts: st.mtimeMs, cover: "" });
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  return items;
}

function findSlidesJsonIn(dir, fsMod) {
  try {
    for (const n of fsMod.readdirSync(dir)) {
      if (!n.endsWith(".json")) continue;
      try {
        const d = JSON.parse(fsMod.readFileSync(join(dir, n), "utf8"));
        if (d && typeof d === "object" && Array.isArray(d.slides)) return join(dir, n);
      } catch { /* 跳过坏 json */ }
    }
  } catch { /* 忽略 */ }
  return null;
}

/**
 * 读一个 deck 的全部页面（给 PptStudio 渲染）。
 * relDir 必须在 outRoot 内且真实存在；返回 { dir, pages:[{file,title,layout,html}] } 或 null
 */
export function readDeck(outRoot, relDir, fsMod = fs) {
  const rootName = basename(outRoot);
  const parts = String(relDir || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts[0] !== rootName || parts.some(p => p === "..")) return null; // 必须从 outRoot 出发且无穿越
  const absDir = join(outRoot, ...parts.slice(1));
  if (!fsMod.existsSync(absDir)) return null;
  let list = [];
  const deckPath = join(absDir, "deck.json");
  if (fsMod.existsSync(deckPath)) {
    try {
      const deck = JSON.parse(fsMod.readFileSync(deckPath, "utf8"));
      list = Array.isArray(deck) ? deck : deck.slides || [];
    } catch { /* 坏 json 走兜底 */ }
  }
  if (!list.length) {
    const pdir = join(absDir, "pages");
    if (!fsMod.existsSync(pdir)) return null;
    list = fsMod.readdirSync(pdir).filter(n => n.endsWith(".html")).sort()
      .map(n => ({ file: `pages/${n}`, title: n.replace(".html", ""), layout: "" }));
  }
  const pages = [];
  for (const item of list) {
    const name = String(item?.file || "").split("/").pop(); // 宽容：deck.json 里 file 可能带/不带 pages/ 前缀
    if (!name.endsWith(".html")) continue;
    let f = join(absDir, item.file || name);
    if (!fsMod.existsSync(f)) f = join(absDir, "pages", name); // 兜底：按 pages/ 下的文件名找
    // Prefix checks alone let `ppthtml-a` reach sibling `ppthtml-abuse`.
    // Require a real path separator after the deck directory boundary.
    if ((f !== absDir && !f.startsWith(absDir + sep)) || !fsMod.existsSync(f)) continue;
    pages.push({
      file: `pages/${name}`,
      title: String(item.title || ""),
      layout: String(item.layout || ""),
      html: fsMod.readFileSync(f, "utf8"),
    });
  }
  return pages.length ? { dir: parts.join("/"), pages } : null;
}
