// lib/static.mjs —— 静态资源服务：内存缓存 + ETag 304 + 指纹强缓存
// 从 server.mjs handleStatic 提取（行为零变更 + 性能增强）：
//   1. 内存缓存（mtime 失效）避免每请求全量 readFile
//   2. ETag（W/"size-mtimeMs"）+ If-None-Match → 304，浏览器 revalidate 零成本
//   3. 指纹查询参数（?v= / ?t=）→ 强缓存 immutable（指纹变才更新 URL）
//   4. sw.js 特殊处理：不缓存 + Service-Worker-Allowed 根作用域
import fs from "node:fs";
import path from "node:path";

const FINGERPRINT_RE = /[?&](?:v|t|ver|version)=/i;
// Vite 构建指纹只在静态资产目录内识别；普通图片/图标名称不是指纹。
const HASHED_ASSET_RE = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;

export function resolveStaticPath(root, rawUrl) {
  let p = new URL(rawUrl, "http://localhost").pathname;
  if (p === "/" || p.endsWith("/")) p = `${p === "/" ? "" : p.slice(0, -1)}/index.html`;
  const file = path.join(root, path.normalize(p).replace(/^([\\/])+/, ""));
  if (!file.startsWith(root)) return { ok: false, reason: "forbidden" }; // 穿越防护（URL 解析已折叠 ..，此处是深层兜底）
  return { ok: true, file };
}

export function createStaticServer({ publicDir, mime = {}, logger = null }) {
  const cache = new Map(); // absPath -> { data, mtimeMs, size, etag, mime }
  const root = path.resolve(publicDir);

  function getCached(file, ext) {
    const now = Date.now();
    let hit = cache.get(file);
    try {
      const st = fs.statSync(file);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        hit.lastUsed = now;
        return { cached: true, ...hit };
      }
      const data = fs.readFileSync(file);
      const etag = `W/"${st.size}-${st.mtimeMs}"`;
      hit = { data, mtimeMs: st.mtimeMs, size: st.size, etag, mime: mime[ext] || "application/octet-stream", lastUsed: now };
      cache.set(file, hit);
      if (cache.size > 512) { // 简单 LRU：清掉最久未用的
        let oldest = null;
        for (const [k, v] of cache) if (!oldest || v.lastUsed < oldest.v.lastUsed) oldest = { k, ...v };
        if (oldest) cache.delete(oldest.k);
      }
      return { cached: false, ...hit };
    } catch {
      cache.delete(file);
      return null; // 不存在/无权限
    }
  }

  async function handle(req, res) {
    const { ok, reason, file } = resolveStaticPath(root, req.url);
    if (!ok) { res.writeHead(403); res.end(reason || "forbidden"); return; }
    const ext = path.extname(file).toLowerCase();
    const entry = getCached(file, ext);
    if (!entry) { res.writeHead(404); res.end("not found"); return; }

    const hasFingerprint = FINGERPRINT_RE.test(req.url || "") ||
      HASHED_ASSET_RE.test(new URL(req.url, "http://localhost").pathname);
    const isSw = new URL(req.url, "http://localhost").pathname === "/sw.js";
    const isHtml = ext === ".html";
    const headers = {
      "Content-Type": entry.mime,
      "ETag": entry.etag,
      "Last-Modified": new Date(entry.mtimeMs).toUTCString(),
    };
    if (isSw) {
      headers["Cache-Control"] = "no-cache"; // service worker 必须可更新
      headers["Service-Worker-Allowed"] = "/";
    } else if (hasFingerprint && !isHtml) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable"; // 指纹即版本，永不回源
    } else {
      headers["Cache-Control"] = "no-cache"; // revalidate（ETag 304 兜底）；html 即使带 ?v= 也不能 immutable
    }
    const inm = req.headers?.["if-none-match"];
    if (inm && inm === entry.etag) { res.writeHead(304, { ETag: entry.etag, "Cache-Control": headers["Cache-Control"] }); res.end(); return; }
    res.writeHead(200, headers);
    res.end(entry.data);
  }

  return {
    handle,
    cacheSize: () => cache.size,
    _cache: cache, // 测试/监控用
  };
}
