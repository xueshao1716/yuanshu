// ===== wechat-dedupe.mjs —— 入站消息去重（2026-10-28）=====
//
// 设计借鉴 Hermes（不抄代码）：
//   ① message_id 去重：网络抖动 / 轮询重叠 / 重连补发，同一个 id 不能处理两次；
//   ② **内容指纹去重**：上游会用**新的 message_id 重发同一段文本**——只按 id 去重挡不住。
//      指纹 = md5(发送者 + 文本)，5 分钟窗口。
//
// 为什么必须有：没有去重时，一条重发会让她重新思考、重新调工具、重新发图——重复花钱还刷屏。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEDUP_REL = path.join("记忆", "运行时", "微信去重.json");
export const WINDOW_MS = 5 * 60 * 1000;
export const MAX_KEYS = 500;

const fileOf = (ws) => path.join(String(ws || "."), DEDUP_REL);
const fingerprint = (text) => crypto.createHash("md5").update(String(text || "")).digest("hex");

export function readSeen(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), "utf8"));
    if (raw && typeof raw === "object" && raw.seen && typeof raw.seen === "object") return raw;
  } catch {}
  return { v: 1, seen: {} };
}

function writeSeen(wsRoot, data) {
  fs.mkdirSync(path.dirname(fileOf(wsRoot)), { recursive: true });
  fs.writeFileSync(fileOf(wsRoot), JSON.stringify({ ...data, v: 1, updatedAt: Date.now() }, null, 2), "utf8");
}

const prune = (seen, now) => {
  const out = {};
  for (const [k, at] of Object.entries(seen || {})) {
    if (now - Number(at) < WINDOW_MS) out[k] = at;
  }
  // 超量时丢最旧的
  const entries = Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYS);
  return Object.fromEntries(entries);
};

/**
 * 判断这条是否重复；不重复则顺手记下。
 * @param {{wsRoot:string, sender:string, text?:string, messageId?:string, now?:number}} p
 * @returns {{dupe:boolean, reason?:string}}
 */
export function checkAndMark({ wsRoot, sender, text = "", messageId = "", now = Date.now() } = {}) {
  const who = String(sender || "").trim();
  if (!who) return { dupe: false };
  const data = readSeen(wsRoot);
  const seen = prune(data.seen, now);
  const keys = [];
  const mid = String(messageId || "").trim();
  if (mid) keys.push(`id:${who}:${mid}`);
  const body = String(text || "").trim();
  if (body) keys.push(`c:${who}:${fingerprint(body)}`);

  for (const k of keys) {
    if (seen[k]) {
      seen[k] = now; // 刷新，避免重复消息反复进来
      writeSeen(wsRoot, { ...data, seen });
      return { dupe: true, reason: k.startsWith("id:") ? "message_id" : "content" };
    }
  }
  for (const k of keys) seen[k] = now;
  writeSeen(wsRoot, { ...data, seen });
  return { dupe: false };
}

export function forgetAll(wsRoot) {
  writeSeen(wsRoot, { v: 1, seen: {} });
  return { ok: true };
}
