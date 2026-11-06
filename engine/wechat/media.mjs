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
  const decoded = Buffer.from(String(b64 || ""), "base64").toString("utf8").trim();
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
