// 元枢：久不互动探针（计划任务 yuanshu-companion-nudge 调用）
// 只做一件事：调本机接口 POST /api/companion/nudge，由服务端判断该不该推。
// 判断逻辑（45 分钟 / 3 小时冷却 / 免打扰）全在 engine/companion-nudge.mjs，这里不重复实现。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "app");
const LOG = path.join(ROOT, "nudge.log");
const PORT = process.env.YUANSHU_PORT || "8787";

function log(line) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) fs.renameSync(LOG, LOG + ".1");
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

(async () => {
  let token = "";
  try { token = fs.readFileSync(path.join(APP, ".token"), "utf8").trim() } catch {}
  if (!token) return log("skip=no_token");
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/companion/nudge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text();
    log(`status=${res.status} ${body.slice(0, 200)}`);
  } catch (e) {
    log(`error=${String(e?.message || e).slice(0, 120)}`);
  }
})();
