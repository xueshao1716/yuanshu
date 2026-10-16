// 邮件接入桥：Gmail (IMAP/OAuth2) + Outlook (Microsoft Graph)
// 2026-10-08 伙伴需求：全托管邮箱，新邮件到达时微信通知
import fs from "fs";
import path from "path";
import tls from "tls";
import { fetch } from "undici";
import { defaultWorkspace, workspaceFromEnv } from "./workspace-default.mjs";

// ── 存储路径 ──────────────────────────────────────────────────
const WS_ROOT = workspaceFromEnv() || defaultWorkspace();
const EMAIL_DIR = path.join(WS_ROOT, ".yuanshu", "email");
const CONFIG_FILE = path.join(EMAIL_DIR, "config.json");
const TOKEN_FILE = path.join(EMAIL_DIR, "tokens.json");
fs.mkdirSync(EMAIL_DIR, { recursive: true });

// ── 读写工具 ──────────────────────────────────────────────────
function readJson(file, def = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ── OAuth2 端点 ───────────────────────────────────────────────
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OUTLOOK_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const OUTLOOK_GRAPH = "https://graph.microsoft.com/v1.0";

// ── 刷新 Gmail access token（使用 refresh_token）────────────────
async function refreshGmailToken(creds) {
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Gmail token 刷新失败：${JSON.stringify(data)}`);
  return data.access_token;
}

// ── 刷新 Outlook access token ────────────────────────────────
async function refreshOutlookToken(creds) {
  const res = await fetch(OUTLOOK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
      scope: "https://graph.microsoft.com/Mail.Read offline_access",
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Outlook token 刷新失败：${JSON.stringify(data)}`);
  return { accessToken: data.access_token, refreshToken: data.refresh_token || creds.refreshToken };
}

// ── IMAP over TLS 工具（Gmail）───────────────────────────────
function imapConnect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: true }, () => resolve(sock));
    sock.once("error", reject);
    setTimeout(() => reject(new Error("IMAP 连接超时")), 15000);
  });
}

function imapRead(sock) {
  return new Promise((resolve) => {
    let buf = "";
    const handler = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\r\n")) { sock.off("data", handler); resolve(buf); }
    };
    sock.on("data", handler);
    setTimeout(() => { sock.off("data", handler); resolve(buf); }, 5000);
  });
}

function imapCmd(sock, tag, cmd) {
  return new Promise((resolve) => {
    let buf = "";
    const handler = (chunk) => {
      buf += chunk.toString();
      if (buf.includes(`${tag} OK`) || buf.includes(`${tag} NO`) || buf.includes(`${tag} BAD`)) {
        sock.off("data", handler);
        resolve(buf);
      }
    };
    sock.on("data", handler);
    sock.write(`${tag} ${cmd}\r\n`);
    setTimeout(() => { sock.off("data", handler); resolve(buf); }, 10000);
  });
}

// ── Gmail IMAP 拉取未读邮件（XOAUTH2）───────────────────────
async function fetchGmailUnread(account) {
  const tokens = readJson(TOKEN_FILE);
  let accessToken = tokens[account.email]?.accessToken;
  // 每次都刷新，简单粗暴，避免过期
  try {
    accessToken = await refreshGmailToken(account);
    tokens[account.email] = { accessToken, updatedAt: Date.now() };
    writeJson(TOKEN_FILE, tokens);
  } catch (e) {
    if (!accessToken) throw e;
  }

  // XOAUTH2 base64
  const authStr = Buffer.from(`user=${account.email}\x01auth=Bearer ${accessToken}\x01\x01`).toString("base64");
  const sock = await imapConnect("imap.gmail.com", 993);
  await imapRead(sock); // greeting
  await imapCmd(sock, "a1", `AUTHENTICATE XOAUTH2 ${authStr}`);
  await imapCmd(sock, "a2", "SELECT INBOX");
  const searchRes = await imapCmd(sock, "a3", "SEARCH UNSEEN");
  const uids = (searchRes.match(/\* SEARCH([\d ]*)/)?.[1] || "").trim().split(" ").filter(Boolean);

  const emails = [];
  for (const uid of uids.slice(-10)) { // 最多取最新 10 封
    const fetchRes = await imapCmd(sock, `a${uid}f`, `FETCH ${uid} (BODY[HEADER.FIELDS (FROM SUBJECT DATE)] BODY[TEXT]<0.500>)`);
    const from = fetchRes.match(/From:\s*(.+)/i)?.[1]?.trim() || "";
    const subject = fetchRes.match(/Subject:\s*(.+)/i)?.[1]?.trim() || "(无主题)";
    const date = fetchRes.match(/Date:\s*(.+)/i)?.[1]?.trim() || "";
    const bodyMatch = fetchRes.match(/\{(\d+)\}\r\n([\s\S]*?)(?=a\d|$)/);
    const snippet = bodyMatch?.[2]?.replace(/[\r\n]+/g, " ").trim().slice(0, 200) || "";
    emails.push({ uid, from, subject, date, snippet, provider: "gmail", account: account.email });
  }

  await imapCmd(sock, "a99", "LOGOUT");
  sock.destroy();
  return emails;
}

// ── Outlook Graph 拉取未读邮件 ───────────────────────────────
async function fetchOutlookUnread(account) {
  const tokens = readJson(TOKEN_FILE);
  let { accessToken, refreshToken } = tokens[account.email] || {};

  try {
    const refreshed = await refreshOutlookToken({ ...account, refreshToken: refreshToken || account.refreshToken });
    accessToken = refreshed.accessToken;
    tokens[account.email] = { accessToken, refreshToken: refreshed.refreshToken, updatedAt: Date.now() };
    writeJson(TOKEN_FILE, tokens);
  } catch (e) {
    if (!accessToken) throw e;
  }

  const res = await fetch(
    `${OUTLOOK_GRAPH}/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=10&$select=id,from,subject,receivedDateTime,bodyPreview&$orderby=receivedDateTime desc`,
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
  if (!res.ok) throw new Error(`Outlook Graph 请求失败：${res.status}`);
  const data = await res.json();
  return (data.value || []).map((m) => ({
    uid: m.id,
    from: m.from?.emailAddress?.address || "",
    subject: m.subject || "(无主题)",
    date: m.receivedDateTime || "",
    snippet: (m.bodyPreview || "").slice(0, 200),
    provider: "outlook",
    account: account.email,
  }));
}

// ── 通用 IMAP（QQ / 163 / 126 / 其他：邮箱地址 + 授权码）────────
// 授权码不是邮箱登录密码：QQ 在「设置-账户」开启 IMAP 后生成；163/126 还要先发 IMAP ID 命令，否则报「不安全登录」。
export const IMAP_PRESETS = {
  qq: { label: "QQ 邮箱", host: "imap.qq.com", port: 993, idRequired: false },
  "163": { label: "163 邮箱", host: "imap.163.com", port: 993, idRequired: true },
  "126": { label: "126 邮箱", host: "imap.126.com", port: 993, idRequired: true },
  custom: { label: "其他 IMAP", host: "", port: 993, idRequired: false },
};

/** IMAP 字符串加引号并转义（密码里可能有 " 或 \） */
export function imapQuote(s) {
  return `"${String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** RFC 2047 编码头解码（=?UTF-8?B?...?= / =?GBK?Q?...?=），解不出就原样返回 */
export function decodeMime(s) {
  return String(s || "")
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
      try {
        const bytes = enc.toUpperCase() === "B"
          ? Buffer.from(txt, "base64")
          : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
        try { return new TextDecoder(cs.toLowerCase()).decode(bytes); }
        catch { return bytes.toString("utf8"); }
      } catch { return txt; }
    });
}

/** 从 IMAP FETCH 返回的头部文本里取一个头（支持折行） */
function imapHeader(text, name) {
  const m = String(text).match(new RegExp(`^${name}:[ \t]*((?:.*)(?:\r?\n[ \t]+.*)*)`, "mi"));
  return m ? decodeMime(m[1].replace(/\r?\n[ \t]+/g, " ").trim()) : "";
}

/** 在已连接（TLS）的 IMAP socket 上：问候 → (163/126 需 ID) → LOGIN → SELECT → UID SEARCH UNSEEN → 取头 → LOGOUT。
 *  用 BODY.PEEK 取头，不把邮件标记为已读。登录失败抛错（错误信息不含密码）。 */
export async function imapSessionUnread(sock, account) {
  await imapRead(sock); // greeting
  if (account.idRequired) await imapCmd(sock, "a0", 'ID ("name" "pi-web" "version" "1.0")');
  const login = await imapCmd(sock, "a1", `LOGIN ${imapQuote(account.email)} ${imapQuote(account.password)}`);
  if (!/^a1 OK/m.test(login)) {
    const why = login.match(/^a1 (?:NO|BAD)[^\r\n]*/m)?.[0] || "服务器无响应";
    throw new Error(`IMAP 登录失败（这里要填邮箱的「授权码」，不是登录密码）：${why}`);
  }
  await imapCmd(sock, "a2", "SELECT INBOX");
  const searchRes = await imapCmd(sock, "a3", "UID SEARCH UNSEEN");
  const uids = (searchRes.match(/\* SEARCH([\d ]*)/)?.[1] || "").trim().split(/\s+/).filter(Boolean);
  const emails = [];
  for (const uid of uids.slice(-10)) { // 最多取最新 10 封
    const r = await imapCmd(sock, `f${uid}`, `UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`);
    emails.push({
      uid,
      from: imapHeader(r, "From"),
      subject: imapHeader(r, "Subject") || "(无主题)",
      date: imapHeader(r, "Date"),
      snippet: "",
      provider: "imap",
      account: account.email,
    });
  }
  await imapCmd(sock, "a99", "LOGOUT");
  return emails;
}

async function fetchImapUnread(account) {
  const preset = IMAP_PRESETS[account.preset] || {};
  const host = preset.host || account.host;
  if (!host) throw new Error("IMAP 服务器地址未配置");
  const sock = await imapConnect(host, Number(account.port) || 993);
  try {
    return await imapSessionUnread(sock, { ...account, idRequired: !!preset.idRequired });
  } finally {
    sock.destroy();
  }
}

// ── 已处理 UID 缓存，避免重复通知 ────────────────────────────
const SEEN_FILE = path.join(EMAIL_DIR, "seen.json");
function loadSeen() { return new Set(readJson(SEEN_FILE, [])); }
function saveSeen(set) { writeJson(SEEN_FILE, [...set].slice(-2000)); }

// ── 轮询主循环 ───────────────────────────────────────────────
let _notifyFn = null;
let _pollTimer = null;
let _running = false;

export function setNotifyFn(fn) { _notifyFn = fn; }

async function pollOnce() {
  const config = readJson(CONFIG_FILE);
  const accounts = config.accounts || [];
  const seen = loadSeen();
  const newMails = [];

  for (const acc of accounts) {
    if (!acc.enabled) continue;
    try {
      const mails = acc.provider === "gmail" ? await fetchGmailUnread(acc)
        : acc.provider === "imap" ? await fetchImapUnread(acc)
        : await fetchOutlookUnread(acc);
      for (const m of mails) {
        const key = `${acc.email}:${m.uid}`;
        if (!seen.has(key)) { seen.add(key); newMails.push(m); }
      }
    } catch (e) {
      console.error(`[email] ${acc.email} 轮询失败：`, e.message);
    }
  }

  if (newMails.length) {
    saveSeen(seen);
    if (_notifyFn) {
      for (const m of newMails) {
        const msg = `📧 ${m.provider === "gmail" ? "Gmail" : m.provider === "imap" ? `邮箱（${m.account}）` : "Outlook"} 新邮件\n发件人：${m.from}\n主题：${m.subject}\n摘要：${m.snippet || "(空)"}`;
        await _notifyFn(msg).catch(() => {});
      }
    }
  }
  return newMails;
}

export function startPolling(intervalMs = 60_000) {
  if (_running) return;
  _running = true;
  const tick = async () => {
    try { await pollOnce(); } catch {}
    if (_running) _pollTimer = setTimeout(tick, intervalMs);
  };
  _pollTimer = setTimeout(tick, intervalMs);
}

export function stopPolling() {
  _running = false;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

// ── 公开 API ─────────────────────────────────────────────────
export function getConfig() { return readJson(CONFIG_FILE); }

const SECRET_FIELDS = ["clientSecret", "refreshToken", "password"];
export function saveConfig(config) {
  // 前端拿到的是脱敏配置（没有密钥）。整包写回时，缺省的密钥要从旧配置里补回来，否则增删启停会把已配好的账号凭证清空。
  const prev = readJson(CONFIG_FILE, {});
  const prevByEmail = new Map((prev.accounts || []).map((a) => [a.email, a]));
  const accounts = (config.accounts || []).map((a) => {
    const old = prevByEmail.get(a.email) || {};
    const merged = { ...a };
    for (const k of SECRET_FIELDS) {
      if ((merged[k] === undefined || merged[k] === "") && old[k]) merged[k] = old[k];
    }
    return merged;
  });
  writeJson(CONFIG_FILE, { ...config, accounts });
}

export function status() {
  const config = readJson(CONFIG_FILE);
  const accounts = (config.accounts || []).map((a) => ({
    email: a.email,
    provider: a.provider,
    enabled: a.enabled,
    hasCredentials: a.provider === "imap" ? !!a.password : !!(a.clientId && a.refreshToken),
  }));
  return { running: _running, accounts };
}

export async function pollNow() { return pollOnce(); }
