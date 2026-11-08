// engine/media/markdown-images.mjs —— 正文 Markdown 外链图归档（2026-11-08）
//
// 产品原则（已确立）：远程图片必须先落盘本地，再发本地地址；厂商地址随时会失效，
// 不能作为交付物。聊天正文里的 `![alt](https://…)` 以前漏在这条规矩外面：
//   · 前端 Markdown 把远端 src 交给 /api/proxy/image 代理显示——代理仍然依赖厂商地址活着；
//   · 旧会话里存着的厂商地址，厂商一关就永久裂图。
//
// 这个模块只做一件事：把**正文文本里的远端 Markdown 图片**换成本地存档地址。
// 它不碰图片块、视频、附件；那些已有各自的闸门（media/embed.mjs、media/api.mjs）。
//
// 三种结果（缓存文件 记忆/运行时/外链图归档.json，url → {local,size,at,ok,reason}）：
//   ① 命中 ok            → 直接用缓存里的本地地址替换（纯同步，不联网）；
//   ② 命中失败且未过期    → 不再尝试，整张图替换成一行文字（默认 24h 内不重试）；
//   ③ 未命中 / 失败已过期 → 下载到 生成物/图片/<日期>/，成功写缓存并替换本地地址；
//                          失败写失败缓存，整张图替换成一行文字，**不保留远端地址**。
//
// 两条硬约束：
//   · 单条消息默认最多下载 3 张（maxPerMessage），避免打开一屏旧会话就触发大量下载；
//     超出部分直接替换成文字说明，不排队、不偷偷下。
//   · 任何异常都降级成文字说明，绝不把原远端 URL 留在输出里，也绝不抛错。
//
// 读路径（extractMessages）用 localizeMarkdownImagesCached：只查缓存、永不联网，
// 所以它可以在同步函数里安全调用。写路径用 localizeMarkdownImages：可以下载并回写缓存。

import fs from "node:fs";
import path from "node:path";
import { isLocalImageUrl } from "./embed.mjs";

export const ARCHIVE_REL = path.join("记忆", "运行时", "外链图归档.json");
export const DEFAULT_MAX_PER_MESSAGE = 3;
/** 失败缓存有效期：24 小时内不再重试同一个地址（厂商 404/502 时避免每次翻历史都重下）。 */
export const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
/** 归档失败/超限时替换成的文字。不露出远端地址，也不假装图还在。 */
export const IMAGE_UNAVAILABLE_NOTE = "（一张外链图没能归档，已不展示）";
/** 成功条目尽量长留（旧会话还要靠它），只给极端长期使用设一个上限。 */
const MAX_ARCHIVE_ENTRIES = 5000;

// `![alt](url "title")`：url 允许 <...> 包裹；不匹配跨行的复杂写法。
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
// `![视频](x.mp4)` 是既有写法（落盘把视频也写成 markdown），它不是图片，不能拿去归档成图片。
const NON_IMAGE_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|m3u8|mp3|m4a|wav|ogg|oga|flac|aac|opus)(?:$|[?#])/i;

let _configuredRoot = "";
// 按文件 mtime 缓存解析结果：extractMessages 会被每个会话请求调用很多次，
// 不能每次都 JSON.parse 一遍归档表。命中的同步判断只花一次 stat。
const _archiveCache = new Map();

/** 服务启动时注入工作区根（= CONFIG.cwd）。不注入时读路径只做内存判断，不落盘。 */
export function configureMarkdownImages({ wsRoot = "" } = {}) {
  const next = String(wsRoot || "").trim();
  if (next === _configuredRoot) return;
  _configuredRoot = next;
  _archiveCache.clear();
}

/** 显式传入优先；否则用 configureMarkdownImages 注入的根；再否则看环境变量。 */
export function markdownImagesRoot(explicit = "") {
  return String(explicit || _configuredRoot || process.env.YUANSHU_WORKSPACE || process.env.PI_WORKSPACE || "").trim();
}

function archiveFile(wsRoot = "") {
  const root = markdownImagesRoot(wsRoot);
  return root ? path.join(root, ARCHIVE_REL) : "";
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const at = value.at instanceof Date && Number.isFinite(value.at.getTime())
    ? value.at.toISOString()
    : (typeof value.at === "string" ? value.at : (Number.isFinite(Number(value.at)) && value.at !== "" && value.at != null ? new Date(Number(value.at)).toISOString() : ""));
  return {
    local: typeof value.local === "string" ? value.local : "",
    size: Number(value.size) || 0,
    at,
    ok: value.ok === true,
    reason: typeof value.reason === "string" ? value.reason : "",
  };
}

/**
 * 读取归档表。返回扁平的 `{ [url]: {local,size,at,ok,reason} }`（与磁盘结构一致）。
 * 文件不存在/坏 JSON 都返回空对象；不会抛错。
 */
export function readImageArchive({ wsRoot = "", fsMod = fs, useCache = true } = {}) {
  const file = archiveFile(wsRoot);
  if (!file) return {};
  let mtimeMs = 0;
  try { mtimeMs = fsMod.statSync(file).mtimeMs; } catch { return {}; }
  const key = file.toLowerCase();
  if (useCache) {
    const hit = _archiveCache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  }
  const data = {};
  try {
    const parsed = JSON.parse(fsMod.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [url, value] of Object.entries(parsed)) {
        const entry = normalizeEntry(value);
        if (entry && /^https?:\/\//i.test(url)) data[url] = entry;
      }
    }
  } catch {}
  if (useCache) _archiveCache.set(key, { mtimeMs, data });
  return data;
}

/** 原子写归档表；失败只打日志（归档缓存写不进去不影响本轮显示）。 */
export function writeImageArchive(map, { wsRoot = "", fsMod = fs } = {}) {
  const file = archiveFile(wsRoot);
  if (!file || !map || typeof map !== "object") return false;
  try {
    // 先并一次磁盘上的最新表：两个会话同时归档时，不能后写的把先写的条目抹掉。
    // （原子 rename 仍可能撞车，但窗口从"整轮下载"缩到一次读写。）
    let latest = {};
    try { latest = readImageArchive({ wsRoot, fsMod, useCache: false }); } catch {}
    const combined = { ...latest, ...map };
    const writeNow = Date.now();
    const entries = Object.entries(combined)
      .filter(([url, value]) => {
        if (!/^https?:\/\//i.test(url)) return false;
        const entry = normalizeEntry(value);
        if (!entry) return false;
        // 成功的映射长留（旧会话全靠它）；失败条目过了 24h 就没必要再占地方。
        return entry.ok || failureFresh(entry, writeNow);
      })
      .sort((a, b) => Date.parse(b[1]?.at || "") - Date.parse(a[1]?.at || ""))
      .slice(0, MAX_ARCHIVE_ENTRIES);
    const fileDir = path.dirname(file);
    fsMod.mkdirSync(fileDir, { recursive: true });
    const tmp = path.join(fileDir, `.外链图归档.${process.pid}.${Date.now()}.tmp`);
    fsMod.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries), null, 2), "utf8");
    fsMod.renameSync(tmp, file);
    _archiveCache.delete(file.toLowerCase());
    return true;
  } catch { return false; }
}

/** 只把远端 http(s) 图片算作归档对象；data:/本地/api/ws/file/相对路径都跳过。 */
function isRemoteMarkdownImage(url) {
  const s = String(url || "").trim();
  if (!/^https?:\/\//i.test(s) || isLocalImageUrl(s)) return false;
  return !NON_IMAGE_EXT_RE.test(s);   // 视频/音频走 extractVideos/audios，不当图片归档
}

function forEachMarkdownImage(text, visit) {
  const source = String(text || "");
  if (!source || source.indexOf("![") < 0) return;
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  let m;
  while ((m = MARKDOWN_IMAGE_RE.exec(source))) {
    const url = String(m[2] || "").trim();
    if (!url) continue;
    visit({ full: m[0], alt: m[1] || "", url, index: m.index });
  }
}

/**
 * 找出正文里所有远端 Markdown 图片 URL（http/https，跳过 data:/本地/api/ws/file/视频音频）。
 * 按出现顺序返回（不去重；归档器内部会按 URL 去重后处理）。
 */
export function findMarkdownImages(text) {
  const out = [];
  forEachMarkdownImage(text, ({ url }) => {
    if (isRemoteMarkdownImage(url)) out.push(url);
  });
  return out;
}

function applyReplacements(source, replacements) {
  const text = String(source || "");
  if (!replacements.size || text.indexOf("![") < 0) return text;
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  return text.replace(MARKDOWN_IMAGE_RE, (full, alt, rawUrl) => {
    const url = String(rawUrl || "").trim();
    const hit = replacements.get(url);
    if (!hit) return full;
    if (hit.kind === "local" && hit.local) return `![${alt || ""}](${hit.local})`;
    return IMAGE_UNAVAILABLE_NOTE;
  });
}

function normalizeNow(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : new Date();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    if (Number.isFinite(d.getTime())) return d;
  }
  return new Date();
}

function failureFresh(entry, nowMs) {
  if (!entry || entry.ok) return false;
  const at = typeof entry.at === "number" ? entry.at : Date.parse(entry.at || "");
  return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at < FAILURE_TTL_MS;
}

function validLocal(entry) {
  return !!(entry && entry.ok === true && entry.local && isLocalImageUrl(entry.local));
}

function sizeOfLocal(local, wsRoot = "") {
  try {
    const raw = String(local || "");
    let file = "";
    if (/^\/api\/ws\/file/i.test(raw)) {
      const m = raw.match(/[?&]path=([^&\s]+)/);
      if (!m) return 0;
      let rel = decodeURIComponent(m[1]).replace(/\\/g, "/");
      file = path.isAbsolute(rel) ? rel : path.resolve(markdownImagesRoot(wsRoot) || ".", rel);
    } else if (/^(?:生成物|工程|workshop-out|交付)[\\/]/i.test(raw)) {
      file = path.resolve(markdownImagesRoot(wsRoot) || ".", raw);
    } else if (path.isAbsolute(raw)) {
      file = raw;
    }
    if (!file) return 0;
    const st = fs.statSync(file);
    return st.isFile() ? st.size : 0;
  } catch { return 0; }
}

function baseResult(source, stats) {
  return {
    text: source,
    changed: false,
    found: 0,
    localized: 0,
    failed: 0,
    skipped: 0,
    attempted: 0,
    cached: 0,
    ...stats,
  };
}

function altByUrl(text) {
  const map = new Map();
  forEachMarkdownImage(text, ({ url, alt }) => {
    if (!map.has(url)) map.set(url, String(alt || "").trim());
  });
  return map;
}

/**
 * 读路径专用（详细版）：只查缓存，永不联网、永不写盘。
 * extractMessages 是同步函数，必须用这个版本；只要字符串的调用方用
 * localizeMarkdownImagesCached。
 *   · 缓存命中 ok            → 换本地地址
 *   · 缓存命中失败且未过期    → 换文字说明
 *   · 未命中 / 失败已过期      → 换文字说明（不在读历史时下载；写路径或归档任务负责补）
 */
export function localizeMarkdownImagesCachedDetailed(text, {
  wsRoot = "",
  now = null,
  maxPerMessage = DEFAULT_MAX_PER_MESSAGE,
  map = null,
  fsMod = fs,
} = {}) {
  try {
    const source = String(text ?? "");
    const found = [...new Set(findMarkdownImages(source))];
    if (!found.length) return baseResult(source, { found: 0 });
    const archive = map && typeof map === "object" ? map : readImageArchive({ wsRoot, fsMod });
    const nowMs = normalizeNow(now).getTime();
    const max = Math.max(0, Number.isFinite(Number(maxPerMessage)) ? Math.trunc(Number(maxPerMessage)) : DEFAULT_MAX_PER_MESSAGE);
    const replacements = new Map();
    let localized = 0, failed = 0, skipped = 0, cached = 0;
    for (const url of found) {
      const entry = archive[url];
      if (validLocal(entry)) {
        replacements.set(url, { kind: "local", local: entry.local });
        localized += 1; cached += 1;
        continue;
      }
      if (failureFresh(entry, nowMs)) {
        replacements.set(url, { kind: "note" });
        failed += 1; cached += 1;
        continue;
      }
      // 读路径不下载：没缓存或缓存已过期都直接给文字说明。
      replacements.set(url, { kind: "note" });
      skipped += 1;
    }
    const next = applyReplacements(source, replacements);
    return baseResult(next, {
      changed: next !== source,
      found: found.length,
      localized,
      failed,
      skipped,
      attempted: 0,
      cached,
      max,
    });
  } catch {
    // 纯逻辑不该抛；万一模板/环境异常，至少把远端图换成说明，绝不把 URL 留在正文。
    try {
      const source = String(text ?? "");
      const next = source.replace(MARKDOWN_IMAGE_RE, (full, _alt, rawUrl) =>
        isRemoteMarkdownImage(rawUrl) ? IMAGE_UNAVAILABLE_NOTE : full);
      return baseResult(next, { changed: next !== source, found: findMarkdownImages(source).length, skipped: findMarkdownImages(source).length });
    } catch {
      return baseResult("", {});
    }
  }
}

/** 只关心最终文本的调用方用这个（返回字符串；详细统计用 Detailed 版）。 */
export function localizeMarkdownImagesCached(text, opts = {}) {
  return localizeMarkdownImagesCachedDetailed(text, opts).text;
}

/**
 * 写路径/归档任务用（详细版）：查缓存 → 必要时 saveArtifact 下载 → 写缓存 → 换本地地址。
 *
 * @param {string} text 正文
 * @param {object} opts
 * @param {string} [opts.wsRoot] 工作区根（默认用 configureMarkdownImages 注入值）
 * @param {Function} [opts.saveArtifact] 下载器；返回 { url, local, reason }（见 workspace-api.saveArtifact）
 * @param {Date|number} [opts.now] 便于测试的当前时间
 * @param {number} [opts.maxPerMessage=3] 本条消息最多下载几张
 * @param {object} [opts.map] 注入的归档表（测试用；注入时不写磁盘）
 * @param {boolean} [opts.persist=true] 是否把新结果写回 记忆/运行时/外链图归档.json
 * @returns {Promise<{text:string, changed:boolean, found:number, localized:number, failed:number, skipped:number, attempted:number, cached:number}>}
 */
export async function localizeMarkdownImagesDetailed(text, {
  wsRoot = "",
  saveArtifact = null,
  now = null,
  maxPerMessage = DEFAULT_MAX_PER_MESSAGE,
  map = null,
  persist = true,
  fsMod = fs,
} = {}) {
  const source = String(text ?? "");
  const stats = { found: 0, localized: 0, failed: 0, skipped: 0, attempted: 0, cached: 0 };
  let found = [];
  try {
    found = [...new Set(findMarkdownImages(source))];
    stats.found = found.length;
    if (!found.length) return baseResult(source, stats);
    const injectedMap = map && typeof map === "object" ? map : null;
    const archive = injectedMap || readImageArchive({ wsRoot, fsMod });
    const nowDate = normalizeNow(now);
    const nowMs = nowDate.getTime();
    const max = Math.max(0, Number.isFinite(Number(maxPerMessage)) ? Math.trunc(Number(maxPerMessage)) : DEFAULT_MAX_PER_MESSAGE);
    const alts = altByUrl(source);
    const replacements = new Map();
    let dirty = false;

    for (const url of found) {
      // 每个 URL 单独 try：一张图坏了，不能连累同一条消息里的其它图和整段正文。
      try {
        const entry = archive[url];
        if (validLocal(entry)) {
          replacements.set(url, { kind: "local", local: entry.local });
          stats.localized += 1; stats.cached += 1;
          continue;
        }
        if (failureFresh(entry, nowMs)) {
          replacements.set(url, { kind: "note" });
          stats.failed += 1; stats.cached += 1;
          continue;
        }
        if (stats.attempted >= max) {
          // 超出上限：直接文字说明，不排队、不偷偷下载。
          replacements.set(url, { kind: "note" });
          stats.skipped += 1;
          continue;
        }
        if (typeof saveArtifact !== "function") {
          // 没注入下载器是配置问题，不是厂商失败：不写失败缓存（否则会把地址关 24h），只降级。
          replacements.set(url, { kind: "note" });
          stats.failed += 1;
          continue;
        }
        stats.attempted += 1;
        let saved = null;
        try {
          saved = await saveArtifact({
            type: "image",
            url,
            prompt: alts.get(url) || "外链图",
          });
        } catch (e) {
          saved = { local: false, reason: String(e?.message || e || "下载失败") };
        }
        // saveArtifact 的契约是 { url, local }；测试替身偶尔只给 url，只要地址是本地就认。
        const local = saved && saved.local !== false && saved.url && isLocalImageUrl(saved.url) ? String(saved.url).trim() : "";
        if (local) {
          archive[url] = {
            local,
            size: Number(saved.size) || sizeOfLocal(local, wsRoot),
            at: nowDate.toISOString(),
            ok: true,
            reason: "",
          };
          replacements.set(url, { kind: "local", local });
          stats.localized += 1;
        } else {
          const reason = String(saved?.reason || "下载失败").slice(0, 200);
          archive[url] = { local: "", size: 0, at: nowDate.toISOString(), ok: false, reason };
          replacements.set(url, { kind: "note" });
          stats.failed += 1;
        }
        dirty = true;
      } catch (e) {
        // 单张图的任何异常都只影响它自己。
        try {
          archive[url] = { local: "", size: 0, at: nowDate.toISOString(), ok: false, reason: String(e?.message || e || "归档失败").slice(0, 200) };
        } catch {}
        replacements.set(url, { kind: "note" });
        stats.failed += 1; dirty = true;
      }
    }

    if (dirty && persist && !injectedMap) {
      try { writeImageArchive(archive, { wsRoot, fsMod }); } catch {}
    }
    const next = applyReplacements(source, replacements);
    return baseResult(next, { ...stats, changed: next !== source, max });
  } catch {
    // 顶层异常：整段里所有远端 Markdown 图都换成说明，绝不保留远端 URL。
    try {
      const next = source.replace(MARKDOWN_IMAGE_RE, (full, _alt, rawUrl) =>
        isRemoteMarkdownImage(rawUrl) ? IMAGE_UNAVAILABLE_NOTE : full);
      return baseResult(next, { ...stats, changed: next !== source, failed: stats.failed + found.length });
    } catch {
      return baseResult("", { ...stats, changed: source.length > 0 });
    }
  }
}

/** 只关心最终文本的调用方用这个（返回字符串；详细统计用 Detailed 版）。 */
export async function localizeMarkdownImages(text, opts = {}) {
  return (await localizeMarkdownImagesDetailed(text, opts)).text;
}
