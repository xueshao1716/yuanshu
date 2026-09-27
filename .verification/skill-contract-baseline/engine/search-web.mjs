#!/usr/bin/env node
// ══ 无头浏览器搜索工具（Bing，零 key）——小语主动学习通道 2 ══
// 用法：node search-web.mjs "关键词" [条数=5]
// 输出：JSON 数组 [{ title, url, site, snippet }]
// 原理：playwright-core 无头 chromium 打开 Bing 搜索页，提取结果（绕过 curl 反爬）
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);

// 定位 playwright-core（优先本地/全局包，其次 camoufox-cli 依赖）
function loadPlaywright() {
  try { return require("playwright-core"); } catch {}
  try {
    const root = require("node:child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
    return require(path.join(root, "camoufox-cli", "node_modules", "playwright-core"));
  } catch {}
  return null;
}

// 从 ms-playwright 缓存目录找 chromium 可执行文件
function findChrome(pw) {
  const base = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  try {
    for (const dir of fs.readdirSync(base).sort().reverse()) {
      if (!dir.startsWith("chromium")) continue;
      for (const sub of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]) {
        const p = path.join(base, dir, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  // 系统 Chrome 兜底
  for (const p of ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const q = (process.argv[2] || "").trim();
const count = Math.min(parseInt(process.argv[3], 10) || 5, 8);
if (!q) { console.error(JSON.stringify({ error: "用法: node search-web.mjs \"关键词\" [条数]" })); process.exit(1); }

const pw = loadPlaywright();
if (!pw) { console.error(JSON.stringify({ error: "playwright-core 未找到" })); process.exit(1); }
const chromePath = findChrome(pw);
if (!chromePath) { console.error(JSON.stringify({ error: "未找到 chromium" })); process.exit(1); }

const browser = await pw.chromium.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "zh-CN",
  });
  await page.goto("https://www.bing.com/search?q=" + encodeURIComponent(q) + "&count=" + count, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(2500);
  const results = await page.evaluate((maxCount) => {
    const out = [];
    for (const li of document.querySelectorAll("#b_results > li.b_algo")) {
      const a = li.querySelector("h2 a, .b_title a");
      if (!a) continue;
      const href = a.href || "";
      // 过滤 Bing 内部导航链接（images/videos 等）；ck/a 是结果重定向，保留（可正常跳转）
      const isBingNav = href.startsWith("http") && (() => {
        try { const u = new URL(href); return u.hostname.includes("bing.com") && !href.includes("/ck/a"); } catch { return true; }
      })();
      if (!href.startsWith("http") || isBingNav) continue;
      const cite = li.querySelector("cite")?.textContent?.trim() || "";
      const snip = li.querySelector(".b_caption p, .b_lineclamp2, .b_lineclamp3, .b_snippet, p")?.textContent?.trim() || "";
      out.push({ title: a.textContent.trim().slice(0, 120), url: href, site: cite, snippet: snip.slice(0, 200) });
      if (out.length >= maxCount) break;
    }
    // 宽泛兜底：如果标准结构没提取到，扫所有直接结果 li 的 h2 a
    if (!out.length) {
      for (const li of document.querySelectorAll("#b_results > li")) {
        const a = li.querySelector("h2 a");
        if (!a) continue;
        const href = a.href || "";
        if (!href.startsWith("http") || href.includes("bing.com/ck/a")) continue;
        out.push({ title: a.textContent.trim().slice(0, 120), url: href, site: "", snippet: "" });
        if (out.length >= maxCount) break;
      }
    }
    return out;
  }, count);
  if (!results.length) {
    // 反爬/无结果兜底：返回错误供上层降级
    console.error(JSON.stringify({ error: "Bing 无结果或反爬", query: q }));
    process.exit(2);
  }
  console.log(JSON.stringify(results, null, 1));
} finally {
  await browser.close();
}
