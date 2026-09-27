#!/usr/bin/env node
// ══ pi-web 自动化回归测试 ══
// 用法：node scripts/regression.mjs [baseUrl]
// 覆盖：登录/主界面、会话懒加载、侧边栏拖拽持久化、工具卡时长监控、工作台独立页、移动端无溢出
// 退出码：0=全过 1=有失败（供 CI/发布前检查）
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BASE = process.argv[2] || "http://127.0.0.1:8787";
let TOKEN = process.env.PI_WEB_TOKEN || "";
try { TOKEN = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".token"), "utf8").trim() || TOKEN; } catch {}

// playwright-core（本地/全局/camoufox 依赖）
let pw = null;
try { pw = require("playwright-core"); } catch {
  try { pw = require(path.join(require("node:child_process").execSync("npm root -g", { encoding: "utf8" }).trim(), "camoufox-cli", "node_modules", "playwright-core")); } catch {}
}
if (!pw) { console.error("✗ playwright-core 未找到"); process.exit(1); }
// chromium 可执行文件
function findChrome() {
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
  return null;
}
const CHROME = findChrome();
if (!CHROME) { console.error("✗ 未找到 chromium"); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

const browser = await pw.chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", e => errors.push(String(e).slice(0, 80)));

try {
  // ── 1. 登录 + 主界面 ──
  console.log("═ 1. 登录 + 主界面 ═");
  await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await p.evaluate(t => { localStorage.setItem("pi_web_token", t); }, TOKEN);
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(1800);
  ok("主界面可见", await p.locator("#app").isVisible());
  const items = await p.locator(".session-item").count();
  ok("会话列表渲染 (" + items + " 条)", items > 0);

  // ── 2. 会话懒加载 ──
  console.log("═ 2. 会话懒加载 ═");
  const lazy = await p.evaluate(() => {
    const msgs = [];
    for (let i = 0; i < 150; i++) msgs.push(i % 2 === 0 ? { role: "user", text: "u" + i } : { role: "assistant", text: "a" + i });
    renderMessages(msgs);
    const box = document.getElementById("messages");
    const c1 = document.querySelectorAll("#messages .msg").length;
    const s1 = document.getElementById("lazy-more")?.textContent || "";
    box.scrollTop = 0;
    box.dispatchEvent(new Event("scroll"));
    return new Promise(res => setTimeout(() => {
      const c2 = document.querySelectorAll("#messages .msg").length;
      res({ c1, s1, c2 });
    }, 400));
  });
  ok("初始只渲染 60 条", lazy.c1 === 60);
  ok("哨兵提示剩余", lazy.s1.includes("90"));
  ok("滚动加载更多", lazy.c2 > 60);

  // ── 3. 侧边栏拖拽 + 持久化 ──
  console.log("═ 3. 侧边栏拖拽 ═");
  const drag = await p.evaluate(() => {
    const sidebar = document.getElementById("sidebar");
    const grip = document.querySelector(".sidebar-grip");
    const rect = sidebar.getBoundingClientRect();
    const fire = (t, x) => grip.dispatchEvent(new PointerEvent(t, { clientX: x, pointerId: 1, bubbles: true }));
    fire("pointerdown", rect.right);
    fire("pointermove", rect.left + 350);
    fire("pointerup", rect.left + 350);
    const w = sidebar.getBoundingClientRect().width;
    const stored = localStorage.getItem("pi_sidebar_width");
    return { w, stored };
  });
  ok("拖拽后宽度 ~350 (" + drag.w + ")", Math.abs(drag.w - 350) < 5);
  ok("localStorage 持久化 (" + drag.stored + ")", drag.stored === "350");
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  const afterReload = await p.evaluate(() => document.getElementById("sidebar").getBoundingClientRect().width);
  ok("刷新后保持 (" + afterReload + ")", Math.abs(afterReload - 350) < 5);

  // ── 4. 工具卡时长监控 ──
  console.log("═ 4. 工具卡时长监控 ═");
  const toolDur = await p.evaluate(() => new Promise(res => {
    if (typeof addTool !== "function") return res("no-addTool");
    addTool("bash", "sleep 9", "reg-tool-1", { command: "sleep 9" });
    setTimeout(() => {
      const card = render.toolEls.get("reg-tool-1");
      const t = card ? card.durEl.textContent : "no-card";
      if (card) { card.el.remove(); render.toolEls.delete("reg-tool-1"); }
      res(t);
    }, 1500);
  }));
  ok("running 卡时长显示 (" + toolDur + ")", toolDur.includes("已运行"));

  // ── 5. 工作台独立页 ──
  console.log("═ 5. 工作台独立页 ═");
  const page1 = await p.evaluate(async () => (await fetch("/workshop")).status);
  ok("/workshop 可访问 (" + page1 + ")", page1 === 200);
  const page2 = await p.evaluate(async () => (await fetch("/workshop/ppt")).status);
  ok("/workshop/ppt 可访问 (" + page2 + ")", page2 === 200);
  await p.goto(BASE + "/workshop", { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  ok("首页多卡片 (" + await p.locator(".w-card").count() + ")", (await p.locator(".w-card").count()) >= 3);
  await p.goto(BASE + "/workshop/ppt", { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  // 先清 token 测登录界面（前面步骤已存 token，需移除）
  await p.evaluate(() => localStorage.removeItem("pi_web_token"));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  ok("PPT 页登录界面出现", await p.evaluate(() => getComputedStyle(document.getElementById("w-login")).display === "flex"));
  await p.evaluate(t => { localStorage.setItem("pi_web_token", t); }, TOKEN);
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  ok("登录后主界面+表单", await p.evaluate(() => getComputedStyle(document.getElementById("w-main")).display === "flex" && !!document.getElementById("ws-ppt-theme")));

  // ── 6. 移动端 ──
  console.log("═ 6. 移动端 ═");
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await p.evaluate(t => { localStorage.setItem("pi_web_token", t); }, TOKEN);
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  ok("无横向溢出", await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  ok("抽屉侧边栏", await p.evaluate(() => document.getElementById("sidebar") !== null));
} finally {
  await browser.close();
}

const unrelated = errors.filter(e => !e.includes("live2d") && !e.includes("Version") && !e.includes("loadLive2D"));
ok("零 JS 报错" + (unrelated.length ? "（有 " + unrelated.length + " 条）" : ""), unrelated.length === 0);

console.log("\n═══════════════════════");
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
