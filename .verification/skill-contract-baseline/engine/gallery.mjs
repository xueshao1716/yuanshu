// ══════════════════════════════════════════════════════════
// engine/gallery.mjs —— 作品集路由处理器（扫描式：落盘即收录）
// ══════════════════════════════════════════════════════════
import path from "node:path";
import { scanGallery, readDeck } from "./gallery-core.mjs";

export function handleGalleryList(ctx, res) {
  const { json, WS_ROOT } = ctx;
  const items = scanGallery(path.join(WS_ROOT, "workshop-out"));
  return json(res, 200, { items });
}

export function handleGalleryDeck(ctx, res, req) {
  const { json, WS_ROOT } = ctx;
  const u = new URL(req.url, "http://localhost");
  const deck = readDeck(path.join(WS_ROOT, "workshop-out"), u.searchParams.get("dir") || "");
  if (!deck) return json(res, 404, { error: "作品不存在或路径无效" });
  return json(res, 200, deck);
}

/** 单页封面（卡片缩略用，只回一页 HTML，省流量）*/
export function handleGalleryPage(ctx, res, req) {
  const { json, WS_ROOT } = ctx;
  const u = new URL(req.url, "http://localhost");
  const dir = u.searchParams.get("dir") || "";
  const file = u.searchParams.get("file") || "";
  const deck = readDeck(path.join(WS_ROOT, "workshop-out"), dir);
  if (!deck) return json(res, 404, { error: "作品不存在或路径无效" });
  const page = deck.pages.find(p => p.file === file) || deck.pages[0];
  if (!page) return json(res, 404, { error: "页面不存在" });
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(page.html);
}
