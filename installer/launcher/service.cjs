// 安装版服务入口：把包内运行时排到 PATH 最前，再交给 app/watchdog.cjs 守护 server.mjs。
// 新电脑上什么都没装也能跑：node / python / ffmpeg / git-bash 全部来自安装目录。
// 计划任务 yuanshu-watchdog 和快捷方式都只调用这个文件，环境只在这一处定义。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");
const RT = path.join(ROOT, "runtime");
const APP = path.join(ROOT, "app");

function applyEnv(env = process.env) {
  const dirs = [
    path.join(RT, "node"),
    path.join(RT, "python"),
    path.join(RT, "python", "Scripts"),
    path.join(RT, "ffmpeg", "bin"),
    path.join(RT, "git", "cmd"),
    path.join(RT, "git", "usr", "bin"),
  ];
  // 不按存在过滤：ffmpeg 等可选组件装完即生效，不用重启服务（PATH 里多一个暂不存在的目录无害）
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "Path";
  const rest = String(env[key] || "").split(";").filter((p) => p && !dirs.includes(p));
  env[key] = [...dirs, ...rest].join(";");
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
  try { require("./seed-workspace.cjs").seedWorkspace(path.join(ROOT, "template", "workspace"), process.env.YUANSHU_CWD); }
  catch (e) { console.error("[yuanshu] 工作区初始化失败：", e?.message || e); }
  fs.mkdirSync(process.env.YUANSHU_CWD, { recursive: true });
  process.chdir(APP);
  require(path.join(APP, "watchdog.cjs"));
}
