// ===== read-url.mjs —— 她读网页的能力（2026-11-05）=====
//
// 起因：我读公众号文章很顺（CDP 打开浏览器），她只能 web_search，遇到正文就跑不动。
// 做法：先普通 HTTP 抓（快），拿不到正文再让 headless Chrome --dump-dom 渲染后抓。
//
// 输出：{ ok, url, title, text, via: 'http'|'chrome', chars }
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

export function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/h\d|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t\u3000]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function titleOf(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 120) : "";
}

async function viaHttp(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
  const html = await r.text();
  return { ok: true, html };
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return "";
}

function viaChrome(url, { timeoutMs = 45000 } = {}) {
  const chrome = findChrome();
  if (!chrome) return Promise.resolve({ ok: false, reason: "没有找到 Chrome/Edge" });
  const profile = path.join(os.tmpdir(), `yuanshu-dump-${Date.now().toString(36)}`);
  const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, "--virtual-time-budget=8000", "--dump-dom", url];
  return new Promise((resolve) => {
    execFile(chrome, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
      if (!stdout || String(stdout).trim().length < 200) return resolve({ ok: false, reason: err ? String(err.message).slice(0, 120) : "渲染结果为空" });
      resolve({ ok: true, html: String(stdout) });
    });
  });
}

/** 读一个网址，返回正文文本。 */
export async function readUrl(url, { minChars = 400, force = "" } = {}) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, url: u, error: "不是 http(s) 地址" };
  let html = "", via = "";
  if (force !== "chrome") {
    try {
      const r = await viaHttp(u);
      if (r.ok) { html = r.html; via = "http" }
    } catch (e) { /* 继续走浏览器 */ }
  }
  let text = htmlToText(html);
  if (force === "chrome" || text.length < minChars) {
    const b = await viaChrome(u);
    if (b.ok) { html = b.html; text = htmlToText(b.html); via = "chrome" }
  }
  if (!text || text.length < 80) return { ok: false, url: u, error: "抓不到正文（可能需要登录或被反爬）", via };
  return { ok: true, url: u, title: titleOf(html), text, via, chars: text.length };
}
