// engine/tv.mjs —— 影视：苹果CMS 采集站（vod API）聚合搜索 + 同源 HLS/MP4 代理
// 仓库不内置任何片源：片源列表由用户自己配置，存工作空间 记忆/影视源.json。
// 代理存在的原因：m3u8/分片多数无 CORS、有防盗链、或是 http（页面是 https 时混合内容被拦），
// 统一转成同源 /api/tv/media?url=…，播放器只和元枢说话。
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { createHash } from "node:crypto";

export const TV_SOURCES_REL = "记忆/影视源.json";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_SOURCES = 40;
const MAX_PLAYLIST = 2 * 1024 * 1024;
const MAX_API_BODY = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PLAYABLE = /\.(m3u8|mp4)(?:[?#]|$)/i;

export const sourceKey = (url) => createHash("sha1").update(String(url)).digest("hex").slice(0, 8);

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return privateIp(mapped[1]);
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  return true;
}

/** 只放行公网 http(s)；主机名先解析，解析到内网一律拒绝（防 SSRF 与 DNS 指向内网）。 */
export async function assertPublicUrl(raw, lookup = dns.lookup) {
  let u;
  try { u = new URL(String(raw || "")); } catch { throw new Error("地址不合法"); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("只支持 http/https 地址");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("不允许访问本机或内网地址");
  if (net.isIP(host)) {
    if (privateIp(host)) throw new Error("不允许访问本机或内网地址");
    return u;
  }
  const rows = await lookup(host, { all: true });
  if (!rows.length || rows.some((r) => privateIp(r.address))) throw new Error("不允许访问本机或内网地址");
  return u;
}

/** 手动跟随重定向，每一跳都重新校验公网。 */
export async function safeFetch(raw, { fetch: f = globalThis.fetch, lookup, headers = {}, signal, timeoutMs = 15000 } = {}) {
  let url = raw;
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(url, lookup);
    const res = await f(u.href, { redirect: "manual", signal: sig, headers: { "User-Agent": UA, ...headers } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), u).href;
      try { await res.body?.cancel(); } catch {}
      continue;
    }
    return { res, url: u.href };
  }
  throw new Error("重定向过多");
}

// ── 片源配置 ──
function sourcesFile(wsRoot) { return path.join(String(wsRoot || ""), TV_SOURCES_REL); }

/** 接受 {sources:[{name,api|url}]}、[{name,api|url}]、或 {key:{name,api}} 三种常见订阅格式 */
export function normalizeSources(input) {
  let list = input;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { throw new Error("不是合法的 JSON"); } }
  if (list && !Array.isArray(list) && Array.isArray(list.sources)) list = list.sources;
  else if (list && !Array.isArray(list) && typeof list === "object") list = Object.values(list);
  if (!Array.isArray(list)) throw new Error("需要片源数组");
  const seen = new Set();
  const out = [];
  for (const row of list) {
    const url = String(row?.url || row?.api || "").trim();
    const name = String(row?.name || "").trim().slice(0, 40);
    if (!url || !name) continue;
    let u;
    try { u = new URL(url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ name, url: u.href, key: sourceKey(u.href) });
  }
  if (!out.length) throw new Error("没有可用的片源（每项需要 name 和 http(s) 的 api/url）");
  return out.slice(0, MAX_SOURCES);
}

export function loadSources(wsRoot) {
  try { return normalizeSources(JSON.parse(fs.readFileSync(sourcesFile(wsRoot), "utf8"))); } catch { return []; }
}

export function saveSources(wsRoot, input) {
  const sources = normalizeSources(input);
  const file = sourcesFile(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sources: sources.map(({ name, url }) => ({ name, url })) }, null, 2) + "\n", "utf8");
  return sources;
}

// ── 采集站 API ──
async function callApi(source, query, ctx) {
  const u = new URL(source.url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const { res } = await safeFetch(u.href, { ...ctx, timeoutMs: ctx.timeoutMs ?? 8000, headers: { Accept: "application/json,*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_API_BODY) throw new Error("响应过大");
  try { return JSON.parse(text); } catch { throw new Error("返回的不是 JSON"); }
}

const clean = (s) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();

function brief(source, v) {
  return {
    source: source.key, sourceName: source.name, id: String(v.vod_id ?? ""), name: clean(v.vod_name),
    pic: /^https?:\/\//i.test(v.vod_pic || "") ? v.vod_pic : "", remarks: clean(v.vod_remarks),
    year: clean(v.vod_year), type: clean(v.type_name),
  };
}

export async function searchTv(sources, q, ctx = {}) {
  const query = String(q || "").trim().slice(0, 80);
  if (!query) return { results: [], failed: [] };
  const failed = [];
  const lists = await Promise.all(sources.map(async (s) => {
    try {
      const data = await callApi(s, { ac: "videolist", wd: query }, ctx);
      return (Array.isArray(data?.list) ? data.list : []).map((v) => brief(s, v)).filter((v) => v.id && v.name);
    } catch (e) { failed.push({ source: s.name, error: String(e?.message || e).slice(0, 80) }); return []; }
  }));
  // 同名合并：同名（忽略空白与大小写）的各来源并成一条，展开即可选来源
  const merged = new Map();
  for (const row of lists.flat()) {
    const k = row.name.replace(/\s+/g, "").toLowerCase();
    const hit = merged.get(k);
    if (!hit) merged.set(k, { name: row.name, pic: row.pic, year: row.year, type: row.type, variants: [row] });
    else { hit.variants.push(row); if (!hit.pic) hit.pic = row.pic; }
  }
  return { results: [...merged.values()], failed };
}

/** vod_play_from/vod_play_url → [{name, episodes:[{name,url}]}]，只留能直接播的 m3u8/mp4 */
export function parsePlayGroups(from, urls) {
  const names = String(from || "").split("$$$");
  return String(urls || "").split("$$$").map((block, i) => {
    const episodes = block.split("#").map((seg, n) => {
      const idx = seg.indexOf("$");
      const name = idx >= 0 ? seg.slice(0, idx).trim() : "";
      const url = (idx >= 0 ? seg.slice(idx + 1) : seg).trim();
      return { name: name || `第${n + 1}集`, url };
    }).filter((e) => /^https?:\/\//i.test(e.url) && PLAYABLE.test(e.url));
    return { name: (names[i] || `线路${i + 1}`).trim(), episodes };
  }).filter((g) => g.episodes.length);
}

export async function tvDetail(sources, sourceKeyValue, id, ctx = {}) {
  const source = sources.find((s) => s.key === sourceKeyValue);
  if (!source) throw new Error("片源不存在");
  const data = await callApi(source, { ac: "videolist", ids: String(id) }, ctx);
  const v = Array.isArray(data?.list) ? data.list[0] : null;
  if (!v) throw new Error("没有找到这部片子");
  return { ...brief(source, v), desc: clean(v.vod_content).slice(0, 600), groups: parsePlayGroups(v.vod_play_from, v.vod_play_url) };
}

// ── 同源媒体代理 ──
export function proxyHref(target, token) {
  const p = new URLSearchParams({ url: target });
  if (token) p.set("token", token);
  return `/api/tv/media?${p.toString()}`;
}

/** 把 m3u8 里的相对/绝对地址（分片、子清单、密钥、map）都改写成代理地址 */
export function rewritePlaylist(text, baseUrl, token) {
  const abs = (ref) => { try { return new URL(ref, baseUrl).href; } catch { return null; } };
  return String(text).split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (m, ref) => { const a = abs(ref); return a ? `URI="${proxyHref(a, token)}"` : m; });
    }
    const a = abs(t);
    return a ? proxyHref(a, token) : line;
  }).join("\n");
}

/** 流式代理：m3u8 改写后返回，其余（分片/mp4）原样转发并透传 Range。 */
export async function handleTvMedia(req, res, target, { token = "", fetch: f, lookup } = {}) {
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  let upstream;
  try {
    upstream = await safeFetch(target, { fetch: f, lookup, headers, signal: ac.signal, timeoutMs: 20000 });
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: String(e?.message || e).slice(0, 100) }));
  }
  const { res: up, url: finalUrl } = upstream;
  const type = String(up.headers.get("content-type") || "");
  const looksPlaylist = /mpegurl/i.test(type) || /\.m3u8(?:[?#]|$)/i.test(finalUrl);
  if (looksPlaylist) {
    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.length > MAX_PLAYLIST) { res.writeHead(502); return res.end(); }
    const text = buf.toString("utf8");
    if (text.trimStart().startsWith("#EXTM3U")) {
      res.writeHead(up.status, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return res.end(rewritePlaylist(text, finalUrl, token));
    }
    res.writeHead(up.status, { "Content-Type": type || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    return res.end(buf);
  }
  // 响应面收紧：只搬运媒体字节（音视频/字幕/密钥/TS 分片），其余一律 403，防开放代理
  const mediaUrl = /\.m3u8|\.ts|\.mp4|\.m4s|\.aac|\.vtt|\.key(?:[?#]|$)/i.test(finalUrl);
  const mediaType = /^(video|audio)\//.test(type) || /^application\/octet-stream$/.test(type);
  if (!mediaType && !mediaUrl) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" });
    return res.end(JSON.stringify({ error: "not a media resource" }));
  }
  const out = { "Content-Type": type || "application/octet-stream", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" };
  for (const h of ["content-length", "content-range", "accept-ranges"]) { const v = up.headers.get(h); if (v) out[h] = v; }
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  try {
    const reader = up.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once("drain", r));
    }
  } catch {}
  res.end();
}
