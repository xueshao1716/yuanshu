// 元枢浏览器操作模块（借鉴 badlogic/pi-skills browser-tools：CDP 控制 Chrome）
// 提供：启动 Chrome（远程调试）、导航、截图、取页面文本
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

let chromeProc = null;
let chromePort = 9222;

function findChrome() {
  for (const p of CHROME_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  // PATH 里找
  try {
    const r = execFile("where", ["chrome"], { encoding: "utf8" });
    return r?.trim().split("\n")[0] || null;
  } catch { return null; }
}

// 启动 Chrome（远程调试端口）
export async function startChrome(port = 9222) {
  if (chromeProc) return { ok: true, already: true, port };
  const exe = findChrome();
  if (!exe) return { error: "未找到 Chrome" };
  const profileDir = path.join(os.tmpdir(), "piweb-chrome-" + Date.now());
  chromeProc = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-popup-blocking",
    "--window-size=1280,800", "about:blank",
  ], { stdio: "ignore", detached: false });
  chromePort = port;
  // 等待调试端口就绪
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 2000 }, (res) => {
          res.resume(); resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      });
      if (ok) return { ok: true, port };
    } catch {}
  }
  return { error: "Chrome 启动超时" };
}

// 停止 Chrome
export function stopChrome() {
  if (chromeProc) { try { chromeProc.kill(); } catch {} chromeProc = null; }
  return { ok: true };
}

// CDP 请求辅助
async function cdpSend(port, method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: 1, method, params });
    const req = http.request({ host: "127.0.0.1", port, path: "/json/new?about:blank", method: "PUT", timeout: 5000 }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d || "{}")));
    });
    req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("CDP timeout")); });
    req.end();
  });
}

// 用 WebSocket 发 CDP 命令（导航/截图/取 DOM）
async function cdpWs(port, wsUrl, method, params) {
  const ws = await import("node:repl").catch(() => null); // 占位，实际用原生 WebSocket
  // Node 22+ 有全局 WebSocket
  if (typeof WebSocket === "undefined") return { error: "Node 需 ≥22 才支持 WebSocket" };
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    const id = Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("CDP ws timeout")); }, 15000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id, method, params }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) { clearTimeout(timer); ws.close(); resolve(msg.result || {}); }
      } catch {}
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

// 导航到 URL
export async function navigate(url) {
  const s = await startChrome(chromePort);
  if (s.error) return s;
  try {
    const pages = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: chromePort, path: "/json/list", timeout: 5000 }, (res) => {
        let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
      }).on("error", reject);
    });
    const page = pages.find(p => p.type === "page") || pages[0];
    if (!page) return { error: "无可用页面" };
    const r = await cdpWs(chromePort, page.webSocketDebuggerUrl, "Page.navigate", { url });
    await new Promise(r2 => setTimeout(r2, 1500));
    return { ok: true, title: page.title || "", url };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// 截图（返回 base64 PNG）
export async function screenshot() {
  const s = await startChrome(chromePort);
  if (s.error) return s;
  try {
    const pages = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: chromePort, path: "/json/list", timeout: 5000 }, (res) => {
        let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
      }).on("error", reject);
    });
    const page = pages.find(p => p.type === "page") || pages[0];
    if (!page) return { error: "无可用页面" };
    const r = await cdpWs(chromePort, page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
    if (r && r.data) return { ok: true, data: r.data };
    return { error: "截图失败" };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// 取页面文本
export async function pageText() {
  const s = await startChrome(chromePort);
  if (s.error) return s;
  try {
    const pages = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: chromePort, path: "/json/list", timeout: 5000 }, (res) => {
        let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
      }).on("error", reject);
    });
    const page = pages.find(p => p.type === "page") || pages[0];
    if (!page) return { error: "无可用页面" };
    const r = await cdpWs(chromePort, page.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: "document.body ? document.body.innerText.slice(0, 5000) : ''",
      returnByValue: true,
    });
    const val = r?.result?.value || "";
    return { ok: true, text: String(val).slice(0, 5000) };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
