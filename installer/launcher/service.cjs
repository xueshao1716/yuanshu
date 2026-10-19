// 安装版服务入口：把包内运行时排到 PATH 最前，再交给 app/watchdog.cjs 守护 server.mjs。
// 新电脑上什么都没装也能跑：node / python / ffmpeg / git-bash 全部来自安装目录。
// 计划任务 yuanshu-watchdog 和快捷方式都只调用这个文件，环境只在这一处定义。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");
const RT = path.join(ROOT, "runtime");
const INSTALLED_APP = path.join(ROOT, "app");
// 默认永远用安装目录里的 app。开发机上想临时指向源码仓库，显式设 YUANSHU_DEV_APP 即可：
// 绝不要写成「D:\pi-web 存在就用它」——那会让这台机器的开机自启一直跑开发副本（2026-10-19 真机踩到）。
function resolveApp() {
  const dev = String(process.env.YUANSHU_DEV_APP || "").trim();
  if (dev && fs.existsSync(path.join(dev, "server.mjs"))) return dev;
  return INSTALLED_APP;
}
const APP = resolveApp();

function applyEnv(env = process.env) {
  const win = process.platform === "win32";
  // Linux 包布局：node/bin、python/bin、ffmpeg/bin（可选组件）；Windows 沿用平铺
  const dirs = win ? [
    path.join(RT, "node"),
    path.join(RT, "python"),
    path.join(RT, "python", "Scripts"),
    path.join(RT, "ffmpeg", "bin"),
    path.join(RT, "git", "cmd"),
    path.join(RT, "git", "usr", "bin"),
  ] : [
    path.join(RT, "node", "bin"),
    path.join(RT, "python", "bin"),
    path.join(RT, "ffmpeg", "bin"),
  ];
  // 不按存在过滤：ffmpeg 等可选组件装完即生效，不用重启服务（PATH 里多一个暂不存在的目录无害）
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "Path";
  const rest = String(env[key] || "").split(path.delimiter).filter((p) => p && !dirs.includes(p));
  env[key] = [...dirs, ...rest].join(path.delimiter);
  if (!env.YUANSHU_CWD) env.YUANSHU_CWD = path.join(env.USERPROFILE || os.homedir(), "pi-workspace");
  const bash = path.join(RT, "git", "usr", "bin", "bash.exe");
  if (!env.YUANSHU_BASH && fs.existsSync(bash)) env.YUANSHU_BASH = bash;
  if (!env.U2NET_HOME) env.U2NET_HOME = path.join(RT, "models");
  // 可选组件（engine/addons.mjs）装到这里；YUANSHU_APP 给小语自己运行 scripts/addon.mjs 用
  env.YUANSHU_RUNTIME = RT;
  env.YUANSHU_APP = APP;
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

module.exports = { ROOT, RT, APP, applyEnv };

if (require.main === module) {
  applyEnv();
  // 留痕：开机自启/计划任务到底拉起了哪个目录、哪个 PID
  try {
    const logFile = path.join(ROOT, "launcher.log");
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, logFile + ".1");
    fs.appendFileSync(logFile, `${new Date().toISOString()} pid=${process.pid} app=${APP} root=${ROOT} dev=${APP !== INSTALLED_APP}\n`);
  } catch {}
  try { require("./seed-workspace.cjs").seedWorkspace(path.join(ROOT, "template", "workspace"), process.env.YUANSHU_CWD); }
  catch (e) { console.error("[yuanshu] 工作区初始化失败：", e?.message || e); }
  fs.mkdirSync(process.env.YUANSHU_CWD, { recursive: true });
  process.chdir(APP);
  require(path.join(APP, "watchdog.cjs"));
}
