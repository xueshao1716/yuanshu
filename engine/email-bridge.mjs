// 邮件接入桥：Gmail (IMAP/OAuth2) + Outlook (Microsoft Graph)
// 2026-10-08 伙伴需求：全托管邮箱，新邮件到达时微信通知
import fs from "fs";
import path from "path";
import tls from "tls";
import { fetch } from "undici";

// ── 存储路径 ──────────────────────────────────────────────────
const WS_ROOT = process.env.PI_WORKSPACE || path.join(process.env.USERPROFILE || process.env.HOME || "", "pi-workspace");
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
      const mails = acc.provider === "gmail"
        ? await fetchGmailUnread(acc)
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
        const msg = `📧 ${m.provider === "gmail" ? "Gmail" : "Outlook"} 新邮件\n发件人：${m.from}\n主题：${m.subject}\n摘要：${m.snippet || "(空)"}`;
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

export function saveConfig(config) {
  // 敏感字段不外传：clientSecret 和 refreshToken 只写不读到响应里
  writeJson(CONFIG_FILE, config);
}

export function status() {
  const config = readJson(CONFIG_FILE);
  const accounts = (config.accounts || []).map((a) => ({
    email: a.email,
    provider: a.provider,
    enabled: a.enabled,
    hasCredentials: !!(a.clientId && a.refreshToken),
  }));
  return { running: _running, accounts };
}

export async function pollNow() { return pollOnce(); }
