// 入站语音：下载原始音频（voice_item）供转写（2026-10-28）
//
// 图片走 image_item.media；语音走 voice_item.media —— 结构一样（aes_key + encrypt_query_param），
// 只是文件名/扩展名不同。Hermes 的做法：**永远下载原始音频自己转写**，不信腾讯的 voice_item.text
// （非中文语音会被转成垃圾；见其代码注释 #27300）。
import fs from "node:fs";
import path from "node:path";

/** 从 item 里取媒体描述（图片/语音/文件通用）。 */
export function mediaOf(item) {
  const payload =
    item?.image_item || item?.voice_item || item?.file_item || item?.video_item || null;
  if (!payload) return null;
  const media = payload.media || {};
  const keyRaw =
    media.aes_key ||
    (payload.aeskey ? Buffer.from(String(payload.aeskey), "hex").toString("base64") : "");
  if (!keyRaw || !media.encrypt_query_param) return null;
  return {
    aesKeyB64: keyRaw,
    encryptQueryParam: media.encrypt_query_param,
    filename: payload.file_name || "",
    size: payload.len || payload.file_size || 0,
  };
}

/**
 * 下载 + 解密一条语音到本地。
 * @returns {Promise<{file:string, bytes:number}>}
 */
export async function downloadVoice({ item, outDir, downloadAndDecrypt }) {
  const m = mediaOf(item);
  if (!m) throw Object.assign(new Error("语音条目里没有媒体信息"), { status: 400 });
  const data = await downloadAndDecrypt({
    aesKeyB64: m.aesKeyB64,
    encryptQueryParam: m.encryptQueryParam,
  });
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `wx-voice-${Date.now()}.silk`);
  fs.writeFileSync(file, data);
  return { file, bytes: data.length };
}
