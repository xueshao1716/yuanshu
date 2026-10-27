// ===== outbound.mjs —— 元枢的"向外发"接口层（2026-10-27）=====
//
// 用户原话：「我们其实缺一个向内管，向外发的接口，我们的元枢已经很强大了」
//
// 现状问题：出站能力是**散装**的——微信一个接口、邮件一个、PushPlus 靠 python 脚本，
// 调用方要自己选通道、自己拼参数、自己判断成败；而且**投递结果没有账**
// （今天刚踩过"接口返回 message_id 但用户根本没收到"）。
//
// 这一层是统一口子：
//   · sendOut({text, image, file, voice, channel}) —— 内部按顺序试通道，失败自动降级；
//   · 每次投递都落账（记忆/运行时/投递.json），带通道、结果、失败原因、是否降级；
//   · 通道可扩展：微信 / 邮件 / Webhook / PushPlus。
import fs from "node:fs";
import path from "node:path";

export const LEDGER_REL = path.join("记忆", "运行时", "投递.json");
export const MAX_LEDGER = 200;
export const CHANNELS = ["wechat", "email", "webhook", "pushplus"];

const ledgerFile = (ws) => path.join(String(ws || "."), LEDGER_REL);

export function readLedger(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerFile(wsRoot), "utf8"));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch {}
  return { v: 1, items: [] };
}

function appendLedger(wsRoot, entry) {
  const data = readLedger(wsRoot);
  data.items = [entry, ...(data.items || [])].slice(0, MAX_LEDGER);
  data.updatedAt = Date.now();
  try {
    fs.mkdirSync(path.dirname(ledgerFile(wsRoot)), { recursive: true });
    fs.writeFileSync(ledgerFile(wsRoot), JSON.stringify(data, null, 2), "utf8");
  } catch {}
  return entry;
}

export function payloadOf({ text = "", image = "", file = "", voice = "" } = {}) {
  return { text: String(text || "").slice(0, 2000), image: String(image || ""), file: String(file || ""), voice: String(voice || "") };
}

export const isEmptyPayload = (p) => !p.text && !p.image && !p.file && !p.voice;

export function kindOf(p) {
  if (p.voice) return "voice";
  if (p.file) return "file";
  if (p.image) return "image";
  return "text";
}

/**
 * 统一出站。
 * @param {{wsRoot:string, text?:string, image?:string, file?:string, voice?:string,
 *          channel?:string, fallback?:string[],
 *          deps?:{wechat?:object, email?:object, webhook?:Function, pushplus?:Function}}} p
 */
export async function sendOut(p = {}) {
  const wsRoot = p.wsRoot;
  const body = payloadOf(p);
  if (isEmptyPayload(body)) return { ok: false, channel: "", detail: "内容为空", tried: [], fallbacks: 0, kind: "none" };

  const kind = kindOf(body);
  const preferred = String(p.channel || "wechat");
  const order = [preferred, ...(p.fallback || CHANNELS)].filter((c, i, a) => c && a.indexOf(c) === i);

  const tried = [];
  let fallbacks = 0;

  for (const channel of order) {
    if (!CHANNELS.includes(channel)) { tried.push(`${channel}:未知`); continue }
    if (tried.length) fallbacks += 1;
    tried.push(channel);
    try {
      const r = await sendVia(channel, body, p.deps || {}, wsRoot);
      if (r?.ok) {
        const entry = appendLedger(wsRoot, {
          at: Date.now(), channel, kind, ok: true, detail: String(r.detail || "已发送").slice(0, 160),
          text: body.text.slice(0, 80), fallbacks,
        });
        return { ok: true, channel, detail: entry.detail, tried, fallbacks, kind };
      }
      appendLedger(wsRoot, {
        at: Date.now(), channel, kind, ok: false,
        detail: String(r?.error || "发送失败").slice(0, 160), text: body.text.slice(0, 80), fallbacks,
      });
    } catch (e) {
      appendLedger(wsRoot, {
        at: Date.now(), channel, kind, ok: false,
        detail: String(e?.message || e).slice(0, 160), text: body.text.slice(0, 80), fallbacks,
      });
    }
  }

  return { ok: false, channel: "", detail: `所有通道都失败（试过：${tried.join(" → ")}）`, tried, fallbacks, kind };
}

async function sendVia(channel, body, deps, wsRoot) {
  if (channel === "wechat") {
    const w = deps.wechat;
    if (!w?.notifyOwner) return { ok: false, error: "微信通道未接入" };
    if (body.voice) {
      if (!w.sendVoice) return { ok: false, error: "微信不支持语音条，请改用 file" };
      const r = await w.sendVoice(body.voice);
      return { ok: true, detail: `语音已发（${r?.playtimeMs || 0}ms）` };
    }
    const r = await w.notifyOwner(body.text, body.image, body.file);
    if (r?.failedText > 0 || r?.ret) return { ok: false, error: r?.error || `ret=${r?.ret}` };
    return { ok: true, detail: "微信已发送" };
  }

  if (channel === "email") {
    const e = deps.email;
    if (!e?.send) return { ok: false, error: "邮件通道未接入" };
    const r = await e.send({ subject: "元枢通报", text: body.text, file: body.file || undefined });
    return r?.ok ? { ok: true, detail: "邮件已发送" } : { ok: false, error: r?.error || "邮件发送失败" };
  }

  if (channel === "webhook") {
    const hook = deps.webhook;
    if (typeof hook !== "function") return { ok: false, error: "Webhook 未配置" };
    const r = await hook(body);
    return r?.ok === false ? { ok: false, error: r?.error || "Webhook 失败" } : { ok: true, detail: "Webhook 已推送" };
  }

  if (channel === "pushplus") {
    const pp = deps.pushplus;
    if (typeof pp !== "function") return { ok: false, error: "PushPlus 未配置（面板里存 token）" };
    const r = await pp(body);
    return r?.ok ? { ok: true, detail: r.detail || "PushPlus 已推送" } : { ok: false, error: r?.error || "PushPlus 失败" };
  }

  return { ok: false, error: `未知通道 ${channel}` };
}

export function recentDeliveries(wsRoot, { limit = 20 } = {}) {
  return (readLedger(wsRoot).items || []).slice(0, Math.max(1, limit));
}

/** 给面板/环境事实用的一行摘要。 */
export function outboundLine(wsRoot) {
  const items = recentDeliveries(wsRoot, { limit: 20 });
  if (!items.length) return "";
  const fail = items.filter((i) => !i.ok).length;
  const last = items[0];
  if (!fail) return "";
  return `【投递】最近 20 次里失败 ${fail} 次；最后一次：${last?.channel || "?"} → ${String(last?.detail || "").slice(0, 60)}`;
}
