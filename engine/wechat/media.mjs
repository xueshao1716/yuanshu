// ===== 微信图片收发（2026-10-27）=====
//
// 起因：用户说「你前面做的收发图片，她似乎不会用」。
// 查代码确认：入站只认文本（normalizeMessage 只取 item_type=1），图片直接丢弃；
// 出站只有底层 sendImage，agent 没有任何触发它的途径。
//
// 这版补两头：
//   入站：image_item 里的 encrypt_query_param + aes_key → CDN 下载 → AES-128-ECB 解密 → 存进 收发文件/
//   出站：回复文本里出现本地图片路径（![x](path) 或 单独一行路径）→ 自动当图片发出去
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** iLink 的 aes_key 是 base64(hex 文本)，要还原成 16 字节密钥。 */
export function parseAesKey(b64) {
  // 也有 base64(16 字节原始密钥) 的：语音 / 视频只给 hex aeskey 时，上游就是这样转的
  const bytes = Buffer.from(String(b64 || ""), "base64");
  if (bytes.length === 16) return bytes;
  const decoded = bytes.toString("utf8").trim();
  const hex = /^[0-9a-fA-F]{32}$/.test(decoded) ? decoded : String(b64 || "").replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 32) throw new Error("aes_key 格式不对");
  return Buffer.from(hex, "hex");
}

/** 从消息里取出图片项（item type 2）。 */
export function imageItemsOf(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const out = [];
  for (const it of items) {
    if (Number(it?.type) !== 2) continue;
    const media = it.image_item?.media || {};
    if (!media.encrypt_query_param) continue;
    out.push({
      encryptedQueryParam: String(media.encrypt_query_param),
      aesKey: String(media.aes_key || ""),
      midSize: Number(it.image_item?.mid_size) || 0,
    });
  }
  return out;
}

/** 从消息里取出语音项（item type 3）。 */
export function voiceItemsOf(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const out = [];
  for (const it of items) {
    if (Number(it?.type) !== 3) continue;
    const media = it.voice_item?.media || {};
    if (!media.encrypt_query_param) continue;
    out.push({
      encryptedQueryParam: String(media.encrypt_query_param),
      aesKey: String(media.aes_key || (it.voice_item?.aeskey ? Buffer.from(String(it.voice_item.aeskey), "hex").toString("base64") : "")),
      playtime: Number(it.voice_item?.playtime) || 0,
    });
  }
  return out;
}

/**
 * 下载并解密一条语音（返回 silk 原始字节落盘）。
 * 不复用 downloadImage 是因为扩展名和目录不同；解密逻辑一致。
 */
export async function downloadVoice({ item, outDir, fetch: f = globalThis.fetch, cdnBase = "https://novac2c.cdn.weixin.qq.com/c2c" } = {}) {
  const url = `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(item.encryptedQueryParam)}`;
  const res = await f(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`语音下载失败 HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const plain = item.aesKey
    ? (() => {
      const key = parseAesKey(item.aesKey);
      const d = crypto.createDecipheriv("aes-128-ecb", key, null);
      d.setAutoPadding(false);
      const out = Buffer.concat([d.update(raw), d.final()]);
      const pad = out[out.length - 1];
      return pad >= 1 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
    })()
    : raw;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `wx-voice-${Date.now()}.silk`);
  fs.writeFileSync(file, plain);
  return { ok: true, file, bytes: plain.length };
}

/**
 * 下载并解密一张图片。
 * @returns {Promise<{ok:true, file:string, bytes:number}>}
 */
export async function downloadImage({ item, outDir, fetch: f = globalThis.fetch, cdnBase = "https://novac2c.cdn.weixin.qq.com/c2c" } = {}) {
  const url = `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(item.encryptedQueryParam)}`;
  const res = await f(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const plain = item.aesKey
    ? (() => {
      const key = parseAesKey(item.aesKey);
      const d = crypto.createDecipheriv("aes-128-ecb", key, null);
      d.setAutoPadding(false);
      const out = Buffer.concat([d.update(raw), d.final()]);
      const pad = out[out.length - 1];
      return pad >= 1 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
    })()
    : raw;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `wx-${Date.now()}.jpg`);
  fs.writeFileSync(file, plain);
  return { ok: true, file, bytes: plain.length };
}

/**
 * 从回复文本里找出要发送的本地图片路径，并从文本里移除。
 * 支持：![alt](path) / [图片](path) / 单独一行的绝对路径
 * @returns {{text:string, images:string[]}}
 */
export function extractImagePaths(text, { exists = fs.existsSync } = {}) {
  let t = String(text || "");
  const images = [];
  // markdown 图片
  t = t.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_m, p) => {
    if (exists(String(p))) { images.push(String(p)); return "" }
    return _m;
  });
  // 2026-10-28：兼容「!图（路径）」「图(路径)」这类写法——
  // 全角括号、用"图"当说明、甚至不带感叹号；模型和人都真的这么写。
  t = t.replace(/[!！]?\s*[图圖片]\s*[（(]\s*([^）)\n]+?)\s*[）)]/g, (_m, p) => {
    const clean = String(p).replace(/^["'\u201c\u201d]+|[\s"'\u201c\u201d]+$/g, "");
    if (clean && exists(clean)) { images.push(clean); return "" }
    return _m;
  });
  // 单独一行的路径
  const lines = t.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const m = line.trim().match(/^([A-Za-z]:[\\/][^\s]+\.(?:png|jpe?g|webp|gif))$/i);
    if (m && exists(m[1])) { images.push(m[1]); continue }
    kept.push(line);
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), images };
}

// ===== 微信文件 / 视频入站（2026-11-20）=====
// 用户说「微信接口传不了文件」：入站只认文字/图片/语音，file_item(4) 和 video_item(5) 直接被丢，
// 只发文件的消息变成空白消息被跳过。这里补上：同样的 CDN 下载 + AES-128-ECB 解密，按原文件名落盘。

/** 从消息里取出文件项（type 4）和视频项（type 5）。 */
export function fileItemsOf(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const out = [];
  for (const it of items) {
    const type = Number(it?.type);
    if (type !== 4 && type !== 5) continue;
    const body = (type === 4 ? it.file_item : it.video_item) || {};
    const media = body.media || {};
    if (!media.encrypt_query_param) continue;
    const hexKey = body.aeskey || it.aeskey;
    out.push({
      kind: type === 4 ? "file" : "video",
      encryptedQueryParam: String(media.encrypt_query_param),
      aesKey: String(media.aes_key || (hexKey ? Buffer.from(String(hexKey), "hex").toString("base64") : "")),
      fileName: String(body.file_name || ""),
      size: Number(body.len || body.video_size) || 0,
    });
  }
  return out;
}

/** 文件名去掉路径和 Windows 不允许的字符；空了就用兜底名。 */
export function safeFileName(name, fallback) {
  const base = String(name || "").split(/[\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120);
  return base || fallback;
}

/** 下载并解密一个文件 / 视频，按原名存；重名加序号，不覆盖。 */
export async function downloadFile({ item, outDir, fetch: f = globalThis.fetch, cdnBase = "https://novac2c.cdn.weixin.qq.com/c2c" } = {}) {
  const url = `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(item.encryptedQueryParam)}`;
  const res = await f(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`${item.kind === "video" ? "视频" : "文件"}下载失败 HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  let plain = raw;
  if (item.aesKey) {
    const d = crypto.createDecipheriv("aes-128-ecb", parseAesKey(item.aesKey), null);
    d.setAutoPadding(false);
    const out = Buffer.concat([d.update(raw), d.final()]);
    const pad = out[out.length - 1];
    plain = pad >= 1 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const name = safeFileName(item.fileName, item.kind === "video" ? `wx-video-${Date.now()}.mp4` : `wx-file-${Date.now()}`);
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let file = path.join(outDir, name);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(outDir, `${stem}(${i})${ext}`);
  fs.writeFileSync(file, plain);
  return { ok: true, file, bytes: plain.length };
}
