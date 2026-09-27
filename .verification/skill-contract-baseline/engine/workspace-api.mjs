// engine/workspace-api.mjs —— 工作空间：产物落盘 + 文件服务（2026-08-20 从 server.mjs 拆出）
// 依赖注入：initWorkspaceApi({ wsRoot })；json/readBody 来自 http-utils，safeJoin 来自 tools/security
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { json } from "./http-utils.mjs";
import { safeJoin } from "./tools/security.mjs";
import { httpBufferFetch } from "./http.mjs";
import { VERSION_TAG } from "./version.mjs";

let _wsRoot = "";
// 下载器可注入：SSRF 守卫会（正确地）拦掉 127.0.0.1，于是测试没法起个本地服务器冒充"外站"。
// 与其为了测试放宽安全策略，不如照本仓库一贯的 DI 风格留一个正规的缝。
let _fetchArtifact = httpBufferFetch;
export function initWorkspaceApi({ wsRoot = "", fetchImpl = null } = {}) {
  _wsRoot = wsRoot;
  if (typeof fetchImpl === "function") _fetchArtifact = fetchImpl;
  // ⚠️ 2026-08-22 修复：必须在 init 时赋值——原"WS_ROOT = _wsRoot || WS_ROOT"写在模块顶层，
  // 导入时 _wsRoot 还是空串且之后不再更新 → WS_ROOT 恒为 "" → 所有 ws 接口"路径越权"。
  // ESM live binding：这里赋值后，所有 import { WS_ROOT } 的模块同步拿到新值。
  WS_ROOT = wsRoot || WS_ROOT;
}
// 工作空间根（= 会话 cwd，统一反斜杠）；let 导出供外部读引用
export let WS_ROOT = "";

// 智能文件查找：按关键词 + 类型匹配工作空间文件（供交付时精准定位）
// 关键词来自用户请求（如"酒店的ppt"→关键词"酒店"+类型 ppt）；无关键词则按最近/成品优先
const WS_SKIP_DIRS = new Set(["node_modules", ".git", ".thumbs", "backups", ".cache", "temp", "tmp", "__pycache__", ".venv"]);
export function findWorkspaceFiles({ keyword = "", types = null, max = 8, maxDepth = 4 } = {}) {
  try {
    const root = WS_ROOT;
    if (!fs.existsSync(root)) return [];
    const out = [];
    const kw = String(keyword || "").toLowerCase().replace(/[的得了]/g, "");
    // 宽泛词（图片/项目/文档/文件等）命中率太高，不作为匹配关键词——只匹配具体词
    const WEAK_KW = new Set(["图片", "项目", "文档", "文件", "照片", "画", "图", "ppt", "网页", "网站", "配图", "截图", "原图"]);
    const walk = (dir, depth) => {
      if (depth > maxDepth || out.length >= max * 3) return;
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (it.name.startsWith(".") || it.name.startsWith("_")) continue;
        if (WS_SKIP_DIRS.has(it.name)) continue;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) { walk(full, depth + 1); continue; }
        const ext = path.extname(it.name).toLowerCase();
        if (types && !types.includes(ext)) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const rel = path.relative(root, full).replace(/\\/g, "/");
        // 关键词匹配：文件名或路径含关键词（多个关键词任一命中）
        const nameLower = it.name.toLowerCase();
        let score = 0;
        if (kw) {
          const kws = kw.split(/[\s、，,]+/).filter(Boolean);
          for (const k of kws) {
            if (!k || WEAK_KW.has(k)) continue; // 跳过宽泛词
            if (k && (nameLower.includes(k) || rel.toLowerCase().includes(k))) score += 2;
          }
          if (score === 0 && kws.some(k => k && !WEAK_KW.has(k))) continue; // 有具体词但没命中 → 跳过
        }
        out.push({ name: it.name, path: rel, size: st.size, mime: "", mtimeMs: st.mtimeMs, score });
      }
    };
    walk(root, 0);
    // 排序：关键词命中优先 > 成品类型优先 > 最近修改
    const prio = (n) => {
      const e = path.extname(n).toLowerCase();
      if (/^\.(html?|md|pdf|png|jpe?g|gif|webp)$/.test(e)) return 0;
      if (/^\.(pptx?|docx?|zip|mp4|svg|json)$/.test(e)) return 1;
      if (/^\.(js|css|py|txt)$/.test(e)) return 2;
      return 3;
    };
    return out.sort((a, b) => (b.score || 0) - (a.score || 0) || prio(a.name) - prio(b.name) || (b.mtimeMs || 0) - (a.mtimeMs || 0)).slice(0, max);
  } catch { return []; }
}
// 路径安全原语已抽到 engine/tools/security.mjs；此处保留同名薄封装，15+ 调用点零改动
export function wsSafePath(p) {
  return safeJoin(WS_ROOT, p);
}

const WS_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".pdf": "application/pdf",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function wsFileMime(ext) {
  return WS_MIME[String(ext || "").toLowerCase()] || "application/octet-stream";
}

function toWsRel(fp) {
  return path.relative(WS_ROOT, fp).replace(/\\/g, "/");
}

export function resolveDeliveryOpen(fp) {
  try {
    const st = fs.statSync(fp);
    if (st.isFile()) return toWsRel(fp);
    if (!st.isDirectory()) return "";
    const index = path.join(fp, "index.html");
    if (fs.existsSync(index) && fs.statSync(index).isFile()) return toWsRel(index);
    let newest = null;
    for (const name of fs.readdirSync(fp)) {
      if (!/\.(html?|md|txt|pdf)$/i.test(name)) continue;
      const child = path.join(fp, name);
      try {
        const cs = fs.statSync(child);
        if (!cs.isFile()) continue;
        if (!newest || cs.mtimeMs > newest.mtimeMs) newest = { fp: child, mtimeMs: cs.mtimeMs };
      } catch {}
    }
    return newest ? toWsRel(newest.fp) : "";
  } catch {
    return "";
  }
}

export function looksLikeImageBytes(buf) {
  if (!buf || buf.length < 8) return false;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return true;
  return false;
}

export function localDayStamp(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function artifactSlug(prompt = "") {
  const p = String(prompt || "");
  let slug = "元枢";
  if (/小语/.test(p) && /少女|半身像/.test(p)) slug = "小语肖像";
  else {
    const cleaned = p
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/[\s，。！？、,.]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[.\-\s]+|[.\-\s]+$/g, "")
      .slice(0, 32);
    if (cleaned) slug = cleaned;
  }
  // 空提示词回退「元枢」——必须与前端 artifactSlug 的兜底值一致，同一个契约不能有两个兜底
  return slug.slice(0, 32) || "元枢";
}

// ── 产物命名契约 ──────────────────────────────────────────────
// 格式：{提示词摘要}_{类型}_{YYYYMMDD-HHmmss-mmm}-{唯一id}_{v版本}.{扩展名}
// 例：  拳手雨夜车站_视频_20260914-181230-456-a1b2c3d4_v2.8.0.mp4
//
// 为什么带版本：以前产物名里没有任何版本信息，升级后产出的文件跟旧版混在一起分不清。
// 版本进文件名后，"这个视频是哪个版本做的" 看名字就知道，也让版本号真正可观测。
// 契约文档见 docs/NAMING.md；前端镜像实现见 frontend/src/lib/artifact-name.ts，
// 两边的一致性由 tests/unit/naming-contract.test.mjs 钉死。
const ARTIFACT_KIND_LABELS = {
  image: "图片", video: "视频", audio: "音频", music: "音乐",
  text: "文本", novel: "文本", document: "文档", doc: "文档",
  ppt: "演示", html: "网页", code: "代码",
};
const ARTIFACT_KIND_EXTENSIONS = {
  image: ".png", video: ".mp4", audio: ".wav", music: ".mp3",
  text: ".txt", novel: ".txt", document: ".md", doc: ".md",
  ppt: ".pptx", html: ".html", code: ".txt",
};

export function artifactKindLabel(type = "") {
  return ARTIFACT_KIND_LABELS[String(type || "").toLowerCase()] || "产物";
}

export function artifactExtension(type = "") {
  return ARTIFACT_KIND_EXTENSIONS[String(type || "").toLowerCase()] || "";
}

function shortArtifactId() {
  return crypto.randomBytes(4).toString("hex");
}

export function artifactBaseName({ prompt = "", now = new Date(), uniqueId = shortArtifactId(), type = "" } = {}) {
  const d = now instanceof Date ? now : new Date(now);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-`
    + String(d.getHours()).padStart(2, "0")
    + String(d.getMinutes()).padStart(2, "0")
    + String(d.getSeconds()).padStart(2, "0")
    + "-" + String(d.getMilliseconds()).padStart(3, "0");
  const id = String(uniqueId || shortArtifactId()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || shortArtifactId();
  return `${artifactSlug(prompt)}_${artifactKindLabel(type)}_${stamp}-${id}_${VERSION_TAG}`;
}

export function artifactFileName({ prompt = "", type = "", now = new Date(), uniqueId = shortArtifactId() } = {}) {
  return `${artifactBaseName({ prompt, now, uniqueId, type })}${artifactExtension(type)}`;
}

// 用 wx 原子创建占位文件，避免并发生成在同一毫秒选择同一个路径。
// 调用方获得路径后负责写入内容；若后续失败，应删除这个占位文件。
export function allocateArtifactPath(dir, baseName, ext = "") {
  const cleanBase = String(baseName || "产物").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 120) || "产物";
  const extText = String(ext || "");
  const cleanExt = !extText ? "" : extText.startsWith(".") ? extText : `.${extText}`;
  for (let n = 1; n < 10000; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = path.join(dir, `${cleanBase}${suffix}${cleanExt}`);
    try {
      const fd = fs.openSync(candidate, "wx");
      fs.closeSync(fd);
      return candidate;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
  throw new Error("产物命名空间已满");
}

export function artifactSidecarPath(filePath) {
  return String(filePath || "").replace(/\.[^.\\/]+$/, "") + ".json";
}

const ARTIFACT_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".wav", ".mp3", ".m4a", ".ogg",
  ".mp4", ".webm",
]);

// 只有生成物目录里的媒体文件，且旁路内容符合本系统写入格式，才允许随主文件变更。
// 工作区其它文件旁边的同名 JSON 可能是用户自己的数据，必须保持原样。
function isGeneratedArtifactPath(filePath) {
  if (!WS_ROOT || !filePath || !ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  const rel = path.relative(WS_ROOT, filePath);
  if (!rel || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts[0] === "生成物" && parts.length >= 3;
}

function artifactSidecarForMutation(filePath) {
  if (!isGeneratedArtifactPath(filePath)) return "";
  const sidecar = artifactSidecarPath(filePath);
  try {
    const meta = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    if (!meta || typeof meta.prompt !== "string" || !meta.prompt.trim()) return "";
    if (!["image", "audio", "video"].includes(String(meta.type || ""))) return "";
    return sidecar;
  } catch {
    return "";
  }
}

export function writeArtifactSidecar(filePath, { prompt = "", type = "" } = {}) {
  const text = String(prompt || "").trim();
  if (!text || !filePath) return;
  fs.writeFileSync(artifactSidecarPath(filePath), JSON.stringify({
    prompt: text.slice(0, 4000),
    type,
    ts: new Date().toISOString(),
  }));
}

export function readArtifactSidecar(filePath) {
  try {
    const j = JSON.parse(fs.readFileSync(artifactSidecarPath(filePath), "utf8"));
    return String(j.prompt || "").slice(0, 4000);
  } catch {
    return "";
  }
}

// 媒体产物本地化：远程 URL 下载 / data URL 保存 → 落进工作区并返回本地可访问路径。
//
// ── 本地化契约（docs/NAMING.md 第三节）──────────────────────────
// 外站 API（出图/出片/配音）返回的多是**临时链接**，几小时到几天就失效。
// 所以凡是能下载的产物，**必须先下载到本地再入库**，不能把外站 URL 当成品。
//
// 返回 { url, local, reason }：
//   url    该用的地址（成功=本地签名 URL；失败=原外站 URL，让界面至少还能显示）
//   local  是否已经落在本地工作区
//   reason 没落盘的原因（local=false 时一定有），供上层如实告诉用户
//
// 这条契约是补一个**静默失败**：以前下载失败会 catch 住、悄悄把外站 URL 原样返回，
// 调用方（还有三处直接 catch {} 吞掉）根本分不出"已落盘"和"没落盘"，
// 界面上看起来一样，等链接过期才发现产物没了。
export async function saveArtifact(artifact) {
  let reservedFile = "";
  const remote = String(artifact?.url || "");
  const unsaved = reason => ({ url: remote, local: false, reason });
  try {
    const now = new Date();
    const date = localDayStamp(now);
    const typeDir = artifactKindLabel(artifact.type);
    const dir = path.join(WS_ROOT, "生成物", typeDir, date);
    fs.mkdirSync(dir, { recursive: true });
    // 类型表统一由 artifactExtension 提供，别在这里再写一份内联三元——两处判断迟早漂移。
    const ext = artifactExtension(artifact.type) || ".mp4";
    const baseName = artifactBaseName({ prompt: artifact.prompt, now, type: artifact.type });
    let dataBuf = null;
    if (remote.startsWith("data:")) {
      const b64 = remote.split(",")[1];
      dataBuf = Buffer.from(b64, "base64");
      if (artifact.type === "image" && !looksLikeImageBytes(dataBuf)) throw new Error("data URL 不是图片");
    } else if (remote.startsWith("http")) {
      // SSRF 防护：禁止下载内网/回环地址。拦下来是**安全上正确的**，
      // 但不能因此假装产物已本地化——如实回报，让上层决定怎么提示。
      let host = "";
      try { host = new URL(remote).hostname; }
      catch { return unsaved("外站地址无法解析"); }
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "0.0.0.0"
          || host.startsWith("10.") || host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])/.test(host)
          || host.endsWith(".local") || host.endsWith(".internal")) {
        console.log(`[saveArtifact] SSRF 拦截: ${remote}`);
        return unsaved("地址指向内网/回环，出于安全拒绝下载");
      }
      // 原生 fetch 下载（自动系统代理、二进制安全）。上游 CDN 抖动很常见，
      // 失败重试一次再放弃——"没下下来"和"下不下来"是两回事。
      let lastError = "";
      for (let attempt = 1; attempt <= 2 && !dataBuf; attempt++) {
        try {
          const r = await _fetchArtifact(remote, { timeout: 60000 });
          if (!r.ok) { lastError = `下载失败 HTTP ${r.status}`; continue; }
          const buf = r.buffer();
          // 响应体大小限制：50MB（防 OOM）
          if (buf.length > 50 * 1024 * 1024) { lastError = "下载内容超过 50MB 限制"; break; }
          if (!buf.length) { lastError = "下载内容为空"; continue; }
          if (artifact.type === "image" && !looksLikeImageBytes(buf)) { lastError = "下载内容不是图片（可能是 HTML 错误页）"; break; }
          dataBuf = buf;
        } catch (e) {
          lastError = String(e?.message || e).slice(0, 120);
          if (attempt < 2) await new Promise(r => setTimeout(r, 800));
        }
      }
      if (!dataBuf) return unsaved(lastError || "下载失败");
    } else {
      // 既不是 data: 也不是 http(s)：相对路径 / 已在本地的路径。它本来就是本地的，原样返回。
      return { url: remote, local: true, reason: "" };
    }
    reservedFile = allocateArtifactPath(dir, baseName, ext);
    fs.writeFileSync(reservedFile, dataBuf);
    // 落盘校验：写完了不代表写对了。空文件会让"已本地化"变成另一句假话。
    const written = fs.statSync(reservedFile).size;
    if (!written) throw new Error("落盘后文件为空");
    writeArtifactSidecar(reservedFile, { prompt: artifact.prompt, type: artifact.type });
    console.log(`[元枢] 产物已落盘: ${reservedFile}`);
    // 用签名 URL（免鉴权，24h 有效）——img 标签可直接加载，无需带 token
    let localUrl;
    try {
      const fb = await import("./filebox.mjs");
      localUrl = fb.signedUrl(path.relative(WS_ROOT, reservedFile));
    } catch {
      localUrl = `/api/ws/file?path=${encodeURIComponent(reservedFile)}`;
    }
    return { url: localUrl, local: true, reason: "" };
  } catch (e) {
    if (reservedFile) {
      try { if (fs.existsSync(reservedFile) && fs.statSync(reservedFile).size === 0) fs.unlinkSync(reservedFile); } catch {}
      try { const sidecar = artifactSidecarPath(reservedFile); if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar); } catch {}
    }
    const reason = String(e?.message || e).slice(0, 120);
    console.log(`[元枢] 落盘失败（产物未本地化）: ${reason}`);
    return unsaved(reason);
  }
}

// 只关心"该用什么地址"的调用方用这个；需要知道有没有真落盘的必须用 saveArtifact 拿 local/reason。
export async function saveArtifactUrl(artifact) {
  return (await saveArtifact(artifact)).url;
}

// 本地文件产物入库：saveArtifact 只认 data:/http 两种来源（其余原样返回），
// 而「成片合成」这类产物本来就在磁盘上、几十 MB，走 base64 不现实。
// 命名/落盘/sidecar/签名 URL 与 saveArtifact 保持一致，避免出现第二套产物约定。
export async function saveArtifactFromFile({ filePath, type = "video", prompt = "" } = {}) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error("产物文件不存在");
  const now = new Date();
  const date = localDayStamp(now);
  const typeDir = artifactKindLabel(type);
  const dir = path.join(WS_ROOT, "生成物", typeDir, date);
  fs.mkdirSync(dir, { recursive: true });
  // 有真实文件时以它的扩展名为准；否则查类型表（别再写内联三元）
  const ext = path.extname(filePath) || artifactExtension(type) || ".mp4";
  const target = allocateArtifactPath(dir, artifactBaseName({ prompt, now, type }), ext);
  fs.copyFileSync(filePath, target);
  writeArtifactSidecar(target, { prompt, type });
  console.log(`[元枢] 本地产物已入库: ${target}`);
  try {
    const fb = await import("./filebox.mjs");
    return fb.signedUrl(path.relative(WS_ROOT, target));
  } catch {
    return `/api/ws/file?path=${encodeURIComponent(target)}`;
  }
}

// GET /api/ws/tree —— 工作空间目录树
export async function handleWsTree(res, reqPath) {
  const safe = wsSafePath(reqPath || "");
  if (!safe) return json(res, 403, { error: "路径越权" });
  const items = [];
  try {
    for (const it of fs.readdirSync(safe, { withFileTypes: true })) {
      items.push({
        name: it.name,
        type: it.isDirectory() ? "dir" : "file",
        path: path.relative(WS_ROOT, path.join(safe, it.name)).replace(/\\/g, "/"),
      });
    }
  } catch {}
  json(res, 200, { items, current: path.relative(WS_ROOT, safe) || "." });
}

// GET /api/ws/file —— 提供文件（图片/音频/视频/文本；?download=1 强制下载）
export async function handleWsFile(res, req, url) {
  // 优先：签名 URL（path+exp+sig，安全防篡改、可过期，不依赖内存映射）
  const fb = await import("./filebox.mjs");
  let target = null;
  if (url?.searchParams.get("sig")) {
    const v = fb.verifySigned(req);
    if (v.ok) target = wsSafePath(v.rel);
    else return json(res, 403, { error: v.reason || "无权访问" });
  } else if (url?.searchParams.get("path")) {
    // 兼容旧链接（直接 path，需带 token 鉴权）
    target = wsSafePath(url.searchParams.get("path") || "");
  }
  if (!target || !fs.existsSync(target)) return json(res, 404, { error: "文件不存在" });
  const safe = target;
  let stat;
  try { stat = fs.statSync(safe); } catch { return json(res, 404, { error: "文件不存在" }); }
  if (!stat.isFile()) return json(res, 404, { error: "文件不存在" });
  const ext = path.extname(safe).toLowerCase();
  const mime = wsFileMime(ext);
  const headers = { "Content-Type": mime, "Cache-Control": "no-cache" };
  if (url?.searchParams.get("download") === "1") {
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(safe))}`;
  }
  // 断点续传支持（HTTP Range，借鉴 file-transfer-go）：大文件中断后可从断点续传
  const total = stat.size;
  const pipeFile = (options) => {
    const stream = fs.createReadStream(safe, options);
    stream.on("error", () => {
      // 文件可能在 stat 后被删除/替换；不能让流错误升级为 uncaughtException。
      if (typeof res.destroy === "function" && !res.destroyed) res.destroy();
    });
    stream.pipe(res);
  };
  const range = req.headers?.range || "";
  const m = range.match(/bytes=(\d+)-(\d*)/);
  if (m) {
    let start = parseInt(m[1], 10);
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    if (end >= total) end = total - 1;
    headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    headers["Accept-Ranges"] = "bytes";
    headers["Content-Length"] = end - start + 1;
    res.writeHead(206, headers);
    if (String(req?.method || "GET").toUpperCase() === "HEAD") {
      res.end();
      return;
    }
    pipeFile({ start, end });
    return;
  }
  headers["Accept-Ranges"] = "bytes";
  headers["Content-Length"] = total;
  res.writeHead(200, headers);
  // 播放器常先 HEAD 探头；只回头、不灌 body，避免 404 触发重试刷。
  if (String(req?.method || "GET").toUpperCase() === "HEAD") {
    res.end();
    return;
  }
  pipeFile();
}

// GET /api/ws/read —— 读文本文件内容
export async function handleWsRead(res, reqPath) {
  const safe = wsSafePath(reqPath);
  if (!safe || !fs.existsSync(safe) || fs.statSync(safe).isDirectory()) return json(res, 404, { error: "文件不存在" });
  try {
    const content = fs.readFileSync(safe, "utf8");
    json(res, 200, { content, name: path.basename(safe), path: reqPath });
  } catch { json(res, 500, { error: "读取失败（可能非文本）" }); }
}

// POST /api/ws/preview —— 生成演示文稿的结构化内容预览（不改动原文件）
// 浏览器无法原生渲染 PPTX；这里提取每页文字，让资产页至少能快速核对内容，原文件仍可下载/打开。
export async function handleWsPreview(res, body) {
  const reqPath = String(body?.path || "");
  const safe = wsSafePath(reqPath);
  if (!safe || !fs.existsSync(safe) || !fs.statSync(safe).isFile()) return json(res, 404, { error: "文件不存在" });
  const ext = path.extname(safe).toLowerCase();
  if (ext !== ".pptx") return json(res, 400, { error: "当前仅支持 .pptx 内容预览，请下载或新窗口打开 .ppt 文件" });
  let stat;
  try { stat = fs.statSync(safe); } catch { return json(res, 404, { error: "文件不存在" }); }
  if (stat.size > 50 * 1024 * 1024) return json(res, 413, { error: "演示文稿超过 50MB，暂不支持在线内容预览" });
  const script = `import json, sys
from pptx import Presentation
prs = Presentation(sys.argv[1])
slides = []
for i, slide in enumerate(prs.slides, 1):
    lines = []
    for shape in slide.shapes:
        if getattr(shape, "has_text_frame", False):
            for para in shape.text_frame.paragraphs:
                text = "".join(run.text for run in para.runs).strip()
                if text and text not in lines:
                    lines.append(text)
    title = (lines[0] if lines else f"第 {i} 页")[:160]
    slides.append({"index": i, "title": title, "lines": lines[1:] if len(lines) > 1 else lines})
print(json.dumps(slides, ensure_ascii=False))`;
  try {
    const out = await new Promise((resolve, reject) => {
      execFile("python", ["-c", script, safe], { encoding: "utf8", timeout: 25000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    const slides = JSON.parse(String(out || "[]"));
    json(res, 200, { kind: "presentation", name: path.basename(safe), slides, note: "当前为文字内容预览，版式请下载原文件或新窗口打开。" });
  } catch (e) {
    json(res, 422, { error: "PPT 内容预览失败，请下载原文件打开" });
  }
}

// POST /api/ws/write —— 写文件
export async function handleWsWrite(res, body) {
  const { path: p, content } = body || {};
  const safe = wsSafePath(p);
  if (!safe) return json(res, 403, { error: "路径越权" });
  try {
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, content || "");
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: String(e?.message || e).slice(0, 100) }); }
}

// GET /api/ws/artifacts —— 生成物列表（按类型/日期）
// 兼容两种目录结构：<type>/<date>/<file> 与 <type>/<file>（实际工作空间大多为后者）
export async function handleWsArtifacts(res) {
  const out = [];
  const genDir = path.join(WS_ROOT, "生成物");
  const push = (fp, type, date) => {
    try {
      if (/\.json$/i.test(fp)) return;
      const st = fs.statSync(fp);
      if (!st.isFile()) return;
      out.push({
        name: path.basename(fp), type, date,
        path: path.relative(WS_ROOT, fp).replace(/\\/g, "/"),
        size: st.size,
        mtimeMs: st.mtimeMs,
        prompt: readArtifactSidecar(fp),
        url: `/api/ws/file?path=${encodeURIComponent(fp)}`,
      });
    } catch {}
  };
  try {
    for (const type of fs.readdirSync(genDir)) {
      const typePath = path.join(genDir, type);
      let typeStat;
      try { typeStat = fs.statSync(typePath); } catch { continue; }
      if (!typeStat.isDirectory()) continue;
      for (const entry of fs.readdirSync(typePath)) {
        const entryPath = path.join(typePath, entry);
        let es;
        try { es = fs.statSync(entryPath); } catch { continue; }
        if (es.isDirectory()) {
          // 三层：<type>/<date>/<file>
          for (const f of fs.readdirSync(entryPath)) push(path.join(entryPath, f), type, entry);
        } else {
          // 两层：<type>/<file>（date 取文件修改日期）
          push(entryPath, type, es.mtime.toISOString().slice(0, 10));
        }
      }
    }
  } catch {}
  out.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0) || b.date.localeCompare(a.date));
  json(res, 200, { artifacts: out.slice(0, 500) });
}

// ══ 成品交付 ══
export function wsNextVersion(name) {
  const deliverDir = path.join(WS_ROOT, "交付");
  try { fs.mkdirSync(deliverDir, { recursive: true }); } catch {}
  let v = 1;
  while (true) {
    const target = path.join(deliverDir, `${name}-v${v}`);
    if (!fs.existsSync(target) && !fs.existsSync(target + ".zip")) break;
    v++;
  }
  return v;
}
// 递归复制目录
export function wsCopyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const it of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, it.name), d = path.join(dst, it.name);
    if (it.isDirectory()) wsCopyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
// POST /api/ws/deliver —— 一键交付：复制源到 交付目录（name-vN）
export async function handleWsDeliver(res, body) {
  const { sourcePath, name } = body || {};
  const safe = wsSafePath(sourcePath);
  if (!safe || !fs.existsSync(safe)) return json(res, 404, { error: "源不存在" });
  const base = (name || path.basename(safe)).replace(/[\/:*?"<>|\s]+/g, "-").slice(0, 60) || "交付物";
  const v = wsNextVersion(base);
  const target = path.join(WS_ROOT, "交付", `${base}-v${v}`);
  try {
    if (fs.statSync(safe).isDirectory()) wsCopyDir(safe, target);
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(safe, target + path.extname(safe)); }
    json(res, 200, { ok: true, path: `交付/${base}-v${v}`, version: v });
  } catch (e) { json(res, 500, { error: String(e?.message || e).slice(0, 100) }); }
}
// POST /api/ws/deliver/package —— 打包 zip（powershell Compress-Archive）
export async function handleWsPackage(res, body) {
  const { path: p } = body || {};
  const safe = wsSafePath(p);
  if (!safe || !fs.existsSync(safe)) return json(res, 404, { error: "源不存在" });
  const zipName = (path.basename(safe) || "交付物").replace(/[\/:*?"<>|\s]+/g, "-") + ".zip";
  const zipPath = path.join(WS_ROOT, "交付", zipName);
  try {
    const src = fs.statSync(safe).isDirectory() ? path.join(safe, "*") : safe;
    const ps = `Compress-Archive -Path '${src.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    await new Promise((resolve, reject) => execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 120000, windowsHide: true }, (err) => err ? reject(err) : resolve()));
    json(res, 200, { ok: true, path: `交付/${zipName}`, url: `/api/ws/file?path=${encodeURIComponent(zipPath)}` });
  } catch (e) { json(res, 500, { error: "打包失败: " + String(e?.message || e).slice(0, 80) }); }
}
// GET /api/ws/deliveries —— 交付列表
export async function handleWsDeliveries(res) {
  const out = [];
  const deliverDir = path.join(WS_ROOT, "交付");
  try {
    for (const it of fs.readdirSync(deliverDir, { withFileTypes: true })) {
      const fp = path.join(deliverDir, it.name);
      const st = fs.statSync(fp);
      const openPath = resolveDeliveryOpen(fp);
      out.push({
        name: it.name,
        type: it.isDirectory() ? "dir" : "file",
        size: st.size,
        date: st.mtime.toISOString(),
        mtimeMs: st.mtimeMs,
        mtime: st.mtime.toISOString(),
        openPath,
        url: openPath ? `/api/ws/file?path=${encodeURIComponent(openPath)}` : `/api/ws/file?path=${encodeURIComponent(fp)}`,
        wsPath: `交付/${it.name}`,
      });
    }
  } catch {}
  out.sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1));
  json(res, 200, { deliveries: out });
}

// POST /api/ws/rename —— 重命名
export async function handleWsRename(res, body) {
  const { oldPath, newName } = body || {};
  const safeOld = wsSafePath(oldPath);
  const safeNew = safeOld ? wsSafePath(path.join(path.dirname(safeOld), String(newName || ""))) : null;
  if (!safeOld || !safeNew || !fs.existsSync(safeOld)) return json(res, 404, { error: "源不存在" });
  if (!newName || /[\/:*?"<>|]/.test(newName)) return json(res, 400, { error: "非法名称" });
  try {
    const isFile = fs.statSync(safeOld).isFile();
    const oldSidecar = isFile ? artifactSidecarForMutation(safeOld) : "";
    const newSidecar = oldSidecar && isGeneratedArtifactPath(safeNew) ? artifactSidecarPath(safeNew) : "";
    fs.renameSync(safeOld, safeNew);
    // 产物的提示词 sidecar 与文件同名，重命名时一并迁移，避免资产详情丢失生成上下文。
    if (oldSidecar && fs.existsSync(oldSidecar) && !fs.existsSync(newSidecar)) {
      try { fs.renameSync(oldSidecar, newSidecar); } catch {}
    }
    json(res, 200, { ok: true, path: path.relative(WS_ROOT, safeNew).replace(/\\/g, "/") });
  } catch (e) { json(res, 500, { error: String(e?.message || e).slice(0, 100) }); }
}
// POST /api/ws/delete —— 删除（工作空间内）
export async function handleWsDelete(res, body) {
  const { path: p, confirmed } = body || {};
  const safe = wsSafePath(p);
  if (!safe || !fs.existsSync(safe)) return json(res, 404, { error: "不存在" });
  // 双保险：前端已 confirm 后必须带 confirmed:true（防 CSRF / 误调）；且禁止删除工作空间根目录
  if (!confirmed) return json(res, 400, { error: "需要确认" });
  if (safe === WS_ROOT) return json(res, 400, { error: "不能删除工作空间根目录" });
  // TOCTOU 防护：解析真实路径（符号链接可能把校验后的路径指到工作空间外），再次确认在范围内
  try {
    const real = fs.realpathSync(safe);
    const rootReal = fs.realpathSync(WS_ROOT);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      return json(res, 400, { error: "路径超出工作空间范围" });
    }
  } catch { return json(res, 400, { error: "路径解析失败" }); }
  try {
    const isFile = fs.statSync(safe).isFile();
    const sidecar = isFile ? artifactSidecarForMutation(safe) : "";
    fs.rmSync(safe, { recursive: true, force: true });
    if (sidecar && fs.existsSync(sidecar)) {
      try { fs.rmSync(sidecar, { force: true }); } catch {}
    }
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: String(e?.message || e).slice(0, 100) }); }
}
// GET /api/ws/search?q= —— 递归文件名搜索
export async function handleWsSearch(res, q) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, it.name);
      const rel = path.relative(WS_ROOT, fp).replace(/\\/g, "/");
      if (it.isDirectory()) {
        if (it.name === "node_modules" || it.name === ".git" || it.name === "AppData") continue;
        walk(fp, depth + 1);
      } else if (it.name.toLowerCase().includes(String(q || "").toLowerCase())) {
        out.push({ name: it.name, path: rel, type: "file", size: fs.statSync(fp).size });
      }
    }
  };
  try { walk(WS_ROOT, 0); } catch {}
  out.sort((a, b) => a.path.localeCompare(b.path));
  json(res, 200, { results: out.slice(0, 100) });
}
// POST /api/ws/projects —— 新建项目
export async function handleWsProjectCreate(res, body) {
  const { name } = body || {};
  const clean = String(name || "").replace(/[\/:*?"<>|\s]+/g, "-").slice(0, 60);
  if (!clean) return json(res, 400, { error: "缺少项目名" });
  const safe = wsSafePath(path.join("工程", clean));
  if (!safe) return json(res, 403, { error: "路径越权" });
  if (fs.existsSync(safe)) return json(res, 400, { error: "项目已存在" });
  try {
    fs.mkdirSync(safe, { recursive: true });
    fs.writeFileSync(path.join(safe, "README.md"), `# ${clean}

新建项目，用对话描述需求开始开发。
`);
    json(res, 200, { ok: true, path: "工程/" + clean });
  } catch (e) { json(res, 500, { error: String(e?.message || e).slice(0, 100) }); }
}
// POST /api/ws/convert —— 文档转换（docx/xlsx → markdown 文本）
export async function handleWsConvert(res, body) {
  const { path: p } = body || {};
  const safe = wsSafePath(p);
  if (!safe || !fs.existsSync(safe)) return json(res, 404, { error: "不存在" });
  const ext = path.extname(safe).toLowerCase();
  const tmp = safe.replace(/\\/g, "\\\\");
  let script;
  if (ext === ".docx") {
    script = `import docx, sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
d = docx.Document(sys.argv[1])
out = []
for p in d.paragraphs:
    t = p.text.strip()
    if not t: continue
    st = (p.style.name or "").lower() if p.style else ""
    if "heading 1" in st: out.append("# " + t)
    elif "heading 2" in st: out.append("## " + t)
    elif "heading 3" in st: out.append("### " + t)
    else: out.append(t)
for tb in d.tables:
    out.append("")
    for row in tb.rows:
        out.append("| " + " | ".join(c.text.strip() for c in row.cells) + " |")
    out.append("")
print("
".join(out))`;
  } else if (ext === ".xlsx") {
    script = `import openpyxl, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
wb = openpyxl.load_workbook(sys.argv[1], read_only=True)
for ws in wb.worksheets:
    print("## " + ws.title)
    for row in ws.iter_rows(values_only=True):
        vals = [str(c) if c is not None else "" for c in row]
        if any(vals): print("| " + " | ".join(vals) + " |")
    print("")`;
  } else return json(res, 400, { error: "仅支持 docx/xlsx 转 markdown" });
  try {
    const text = await new Promise((resolve, reject) => {
      execFile("python", ["-c", script, tmp], { timeout: 60000, windowsHide: true, encoding: "utf8" }, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    json(res, 200, { ok: true, markdown: text });
  } catch (e) { json(res, 500, { error: "转换失败: " + String(e?.message || e).slice(0, 100) }); }
}
