// ===== delivery-probe.mjs —— delivery_probe：出图/出片之后，一次调用回答"用户到底看不看得见"（2026-11-14）=====
//
// 现场：图本身是好的（HTTP 200 / image/png / 1.4MB / PNG 魔数正确），但为了确认这件事，
// 她跑了十几条 bash：查 serve.log 的 /api/ws/file 状态码分布、读 PNG 头算尺寸、翻 server.mjs
// 与 workspace-api.mjs 的实现、verify_check、delivery_check，然后还是不确信，再来一轮。
//
// 缺的不是工具数量，是"一次就能结案"的入口。这个工具把那些命令要问的四件事一次问完：
//   ① 文件在不在、多大——路径归一与越权边界**复用** engine/workspace-api.mjs（resolveWorkspaceReadFile
//      → safeJoin），不在这里自己拼路径，否则探测结果和 /api/ws/file 的真实行为会分叉。
//   ② 真实格式与扩展名是否一致（PNG/JPEG/GIF/WebP 魔数）；图片再读尺寸（PNG IHDR / JPEG SOF /
//      GIF 逻辑屏幕 / WebP VP8X），读不出就是 null，不猜。
//   ③ 用 engine/media-ticket.mjs 的票据机制生成 /api/ws/file?path=&ticket= 的地址（60 秒）。
//   ④ 用 node 内置 fetch 真请求一次，记 HTTP 状态、Content-Type、字节数。
//
// 边界：fetch 失败不抛，全部进 issues——探测工具自己崩掉，等于又逼她回去翻日志。
// 结果只回给模型（不推聊天）；text 里只有一行结论 + 问题清单，完整结构在 details。
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceReadFile, workspaceReadRoots, wsFileMime } from "../workspace-api.mjs";
import { issueTicket, ticketScopeForPath } from "../media-ticket.mjs";

export const PROBE_ROUTE = "/api/ws/file";
export const PROBE_ORIGIN = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 8000;
// JPEG 的 SOF 可能排在几十 KB 的 EXIF 后面；读前 512KB 足够覆盖常见编码器，又不会为一张图读满盘。
const MAX_HEAD_BYTES = 512 * 1024;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXT_IMAGE_MIME = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});
const IMAGE_LABEL = Object.freeze({
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
});

export const DELIVERY_PROBE_TOOL = {
  type: "function",
  function: {
    name: "delivery_probe",
    description: "出图/出片之后确认「用户到底看不看得见」，一次调用就够：查文件在不在、真实格式与扩展名是否一致、字节数、图片尺寸，再用带票据的地址真请求一遍 /api/ws/file，给出 HTTP 状态、Content-Type 和能不能交付的结论。"
      + "**纪律**：出图/出片后先调它一次；不要为了同一张图去 grep serve.log 的状态码分布、读 server.mjs 或 workspace-api.mjs 的实现，也不要把同一件事再交给 verify_check 或 bash 复核——不确定时先看 issues，它写清了是文件不存在、内容不是图片，还是 HTTP 返回了 JSON。"
      + "path 按工作区根解析（与 /api/ws/file 同一套归一与越界边界），越界会被拒；fetch 默认 true。"
      + "isError=true 只表示「现在还不可交付」，不是工具坏了。带票据的地址 60 秒后失效，别当永久链接贴给用户。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要探测的文件：工作区里的相对路径（如 生成物/图片/x.png），或 /api/ws/file 的 path 参数那串值。",
        },
        fetch: {
          type: "boolean",
          description: "是否真发一次 HTTP 请求到本机服务的 /api/ws/file，默认 true。只有当你只想看本地文件、不想碰服务时才设 false（此时 loadable 一律为 false，因为没验 HTTP）。",
        },
      },
      required: ["path"],
    },
  },
};

// ── 魔数 / 尺寸 ───────────────────────────────────────────────

/** 前 12 字节能认出来的格式；认不出返回 ""（不猜）。 */
export function sniffMagic(head) {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "";
}

function pngSize(b) {
  // signature(8) + length(4) + "IHDR"(4) + width(4) + height(4)
  if (b.length < 24) return null;
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  return w > 0 && h > 0 ? { w, h } : null;
}

function gifSize(b) {
  if (b.length < 10) return null;
  const w = b.readUInt16LE(6);
  const h = b.readUInt16LE(8);
  return w > 0 && h > 0 ? { w, h } : null;
}

function jpegSize(b) {
  if (b.length < 4) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) { i++; continue; } // 段间有填充/垃圾字节时重新对齐
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1]; } // 填充 0xFF
    // 无长度的独立标记：SOI / TEM / RSTn
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / 已到扫描数据仍没见到 SOF
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0..SOF15，排除 DHT(C4)/JPG(C8)/DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      const h = b.readUInt16BE(i + 5);
      const w = b.readUInt16BE(i + 7);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b) {
  if (b.length < 16) return null;
  const fourcc = b.toString("latin1", 12, 16);
  if (fourcc === "VP8X") {
    // 扩展格式：canvas 尺寸是 24 位小端 - 1
    if (b.length < 30) return null;
    const w = 1 + b.readUIntLE(24, 3);
    const h = 1 + b.readUIntLE(27, 3);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  if (fourcc === "VP8L") {
    // 无损：0x2f 后面 4 字节里前 14 位宽、后 14 位高（都减 1）
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (fourcc === "VP8 ") {
    // 有损：帧头 3 字节 + 起始码 9d 01 2a，随后两字节宽、两字节高（低 14 位）
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** 按内容（不是按扩展名）读尺寸；认不出/读不出返回 null。 */
export function readDimensions(mime, head) {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  try {
    if (mime === "image/png") return pngSize(b);
    if (mime === "image/jpeg") return jpegSize(b);
    if (mime === "image/gif") return gifSize(b);
    if (mime === "image/webp") return webpSize(b);
  } catch { /* 截断/损坏的文件不该让探测崩掉 */ }
  return null;
}

// ── 小工具 ───────────────────────────────────────────────────

const normMime = (s) => String(s || "").split(";")[0].trim().toLowerCase();
const isDisplayableMime = (m) => /^(image|video|audio)\//.test(m) || /^text\/html/.test(m) || /^text\/plain/.test(m) || m === "application/pdf";

function readHead(file, size) {
  const n = Math.max(0, Math.min(Number(size) || 0, MAX_HEAD_BYTES));
  if (!n) return Buffer.alloc(0);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** 给 URL 用的工作区相对路径：尽量落在某个可读根下（否则原样回退，让服务端自己判）。 */
function relForUrl(target, input, roots) {
  const list = roots && roots.length ? roots : workspaceReadRoots();
  for (const root of list) {
    const rel = path.relative(root, target);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  return String(input || "").replace(/\\/g, "/");
}

/** 结论行：一行说清能不能交付。 */
function verdictLine(result) {
  const dims = result.dimensions ? ` ${result.dimensions.w}×${result.dimensions.h}` : "";
  const http = result.fetch && result.fetch.status ? `，HTTP ${result.fetch.status}` : "";
  if (result.loadable) return `✅ 可交付：${result.mime} ${result.bytes} 字节${dims}${http}`;
  const reason = result.issues[0] || "原因未知";
  return `❌ 不可交付：${reason}${result.fetch && result.fetch.status ? `（HTTP ${result.fetch.status}）` : ""}`;
}

// ── 执行器 ───────────────────────────────────────────────────

/**
 * 造一个 delivery_probe 执行器。
 * @param {object} opts
 *   roots      可选：注入可读根（测试用）；不传就走 workspace-api 的 WS_ROOT + 候选根，与 /api/ws/file 同口径
 *   baseUrl    本机服务地址（默认 http://127.0.0.1:8787）
 *   fetchImpl  可注入的 fetch（默认 node 内置 fetch）
 *   timeoutMs  HTTP 探测超时（默认 8 秒）
 */
export function createDeliveryProbeExecutor({ roots = null, baseUrl = PROBE_ORIGIN, fetchImpl = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const rootList = Array.isArray(roots) && roots.length ? roots.map((r) => String(r)) : null;
  const origin = String(baseUrl || PROBE_ORIGIN).replace(/\/+$/, "");
  const doFetchRaw = typeof fetchImpl === "function" ? fetchImpl : (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);

  return async function executeDeliveryProbe(args = {}) {
    const input = String(args?.path || "").trim();
    const wantFetch = args?.fetch !== false;
    const issues = [];
    const result = {
      ok: false, path: input, exists: false, bytes: 0, mime: "", magicOk: false,
      dimensions: null, url: "", fetch: null, loadable: false, issues,
    };

    if (!input) {
      issues.push("没给路径：path 必须是工作区里的文件路径");
      return { text: verdictLine(result), isError: true, details: result };
    }

    // ① 路径归一 + 越界边界：与 /api/ws/file 用同一个函数，别在这里另写一套拼路径。
    let target = null;
    try {
      target = rootList ? resolveWorkspaceReadFile(input, { roots: rootList }) : resolveWorkspaceReadFile(input);
    } catch {
      target = null;
    }
    if (!target) {
      issues.push(`路径越界或无法解析：${input}（只能看工作区内的文件）`);
      return { text: verdictLine(result), isError: true, details: result };
    }

    let stat = null;
    try { stat = fs.statSync(target); } catch { stat = null; }
    if (!stat || !stat.isFile()) {
      issues.push("文件不存在（磁盘上没有这个文件，先确认生成物落在哪）");
      return { text: verdictLine(result), isError: true, details: result };
    }

    result.exists = true;
    result.bytes = stat.size;

    // ② 真实格式 / 尺寸
    const head = readHead(target, stat.size);
    const ext = path.extname(target).toLowerCase();
    const expected = EXT_IMAGE_MIME[ext] || "";
    const detected = sniffMagic(head);
    result.mime = detected || wsFileMime(ext);
    if (expected) {
      result.magicOk = detected === expected;
      if (!detected) {
        issues.push(`内容不是 ${IMAGE_LABEL[expected]}：文件头对不上（扩展名是 ${ext}，可能被别的格式或文本/JSON 写进来了）`);
      } else if (detected !== expected) {
        issues.push(`扩展名是 ${ext}，内容其实是 ${IMAGE_LABEL[detected]}（服务端按内容嗅探仍能显示，但扩展名与内容不一致）`);
      }
    } else if (detected) {
      result.magicOk = false;
      issues.push(`扩展名是 ${ext || "（无扩展名）"}，内容其实是 ${IMAGE_LABEL[detected]}`);
    } else {
      result.magicOk = true; // 非图片扩展名且认不出图片魔数：无从比对，不算不一致
    }
    result.dimensions = detected ? readDimensions(detected, head) : null;

    // ③ 带票据的地址（scope 由 /api/ws/file 这条路反推，不手写 "file:"）
    const rel = relForUrl(target, input, rootList);
    const scope = ticketScopeForPath(PROBE_ROUTE);
    let ticket = "";
    try {
      ticket = issueTicket({ scope }).ticket;
    } catch (e) {
      issues.push(`票据签发失败：${String(e?.message || e).slice(0, 120)}——HTTP 探测会拿不到 200，先看服务是否在跑`);
    }
    result.url = `${PROBE_ROUTE}?path=${encodeURIComponent(rel)}${ticket ? `&ticket=${encodeURIComponent(ticket)}` : ""}`;

    // ④ 真请求一次
    if (!wantFetch) {
      issues.push("未做 HTTP 探测（fetch=false）：本地文件在，但用户能不能加载没验");
    } else if (!doFetchRaw) {
      issues.push("当前运行时没有 fetch，跳过 HTTP 探测");
    } else {
      try {
        const res = await doFetchRaw(origin + result.url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)),
        });
        const body = Buffer.from(await res.arrayBuffer());
        result.fetch = {
          status: Number(res.status) || 0,
          contentType: String(res.headers.get("content-type") || ""),
          bytes: body.length,
        };
      } catch (e) {
        const reason = String(e?.name === "TimeoutError" ? `超时（${timeoutMs}ms）` : (e?.message || e)).slice(0, 140);
        result.fetch = { status: 0, contentType: "", bytes: 0 };
        issues.push(`HTTP 探测失败：${reason}（服务没起、端口不对，或被拦了）`);
      }
    }

    // ⑤ 判定：命中哪一条就把话说清，别只回一句"失败"
    if (result.fetch) {
      const { status, contentType, bytes: httpBytes } = result.fetch;
      const ct = normMime(contentType);
      const expectedCt = normMime(result.mime);
      if (status === 200) {
        if (!ct) {
          issues.push("HTTP 200 但没有 Content-Type：浏览器可能当二进制下载");
        } else if (/json/.test(ct)) {
          issues.push(`返回的是 JSON 而不是图片（${contentType}）：多半是接口给的是错误体，或这个地址不是文件通道`);
        } else if (ct !== expectedCt) {
          issues.push(`返回的 Content-Type 是 ${contentType}，不是 ${result.mime}`);
        }
        if (!isDisplayableMime(expectedCt) && !/json/.test(ct)) {
          issues.push(`这个类型（${result.mime}）不是图片/视频/音频，浏览器里不会内联显示`);
        }
      } else if (status === 404) {
        issues.push("HTTP 404：磁盘上有文件，但 /api/ws/file 按这个 path 找不到（检查 path 是否工作区相对路径）");
      } else if (status === 401 || status === 403) {
        issues.push(`HTTP ${status}：票据/鉴权没过（票据只有 60 秒，或密钥换过了）`);
      } else {
        issues.push(`HTTP ${status}：服务端拒绝或出错`);
      }
      if (status === 200 && result.bytes > 0 && httpBytes > 0 && httpBytes !== result.bytes) {
        issues.push(`返回字节数 ${httpBytes} 与磁盘 ${result.bytes} 不一致（可能被截断）`);
      }
    }

    // 判定基准就是"可交付"本身：一条真问题都不剩才算过。
    result.loadable = result.exists && result.magicOk && !!result.fetch && result.fetch.status === 200
      && normMime(result.fetch.contentType) === normMime(result.mime)
      && !/json/.test(normMime(result.fetch.contentType))
      && isDisplayableMime(normMime(result.mime));
    result.ok = result.loadable && issues.length === 0;

    const lines = [verdictLine(result)];
    const dims = result.dimensions ? ` · ${result.dimensions.w}×${result.dimensions.h}` : "";
    lines.push(`文件：${input} · ${result.bytes} 字节 · ${result.mime}${dims}`);
    if (issues.length) {
      lines.push("问题：");
      for (const s of issues) lines.push(`· ${s}`);
    }
    if (result.url) lines.push(`地址（60 秒票据，只用于这次核对）：${result.url}`);

    return { text: lines.join("\n"), isError: !result.ok, details: result };
  };
}

/** 一次性调用（server 执行器表里用这个，比较省事）。 */
export function executeDeliveryProbe(args = {}, opts = {}) {
  return createDeliveryProbeExecutor(opts)(args);
}
