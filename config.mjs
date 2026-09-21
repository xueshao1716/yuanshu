// 元枢配置加载模块（保留旧环境变量名，便于平滑升级）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, ".token");

// 环境变量统一入口：新名 YUANSHU_* 优先，旧名 PI_WEB_* 继续认。
// 实现在 engine/env.mjs，engine/ 下的模块也复用它（避免各写一份导致行为漂移）。
import { env } from "./engine/env.mjs";
import { defaultWorkspace } from "./engine/workspace-default.mjs";

// 访问令牌：环境变量 YUANSHU_TOKEN（旧名 PI_WEB_TOKEN）优先，其次 .token 文件，否则生成一个并保存
function loadToken() {
  const fromEnv = env("TOKEN");
  if (fromEnv) return fromEnv;
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString("hex");
  try {
    fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  } catch {}
  return t;
}

// 外置兼容适配器路径：env 优先，其次本地/全局 node_modules 推导（跨平台，不硬编码）
function resolvePiPackage() {
  // PI_PACKAGE 可能被设成纯空白（cmd 里 `set VAR= && ...` 会写入一个空格）→ 视同未设置，
  // 否则会返回 " " 并让 server.mjs 报 Cannot find module 'D:\pi-web\ '
  const fromEnv = String(process.env.PI_PACKAGE || "").trim();
  if (fromEnv) return fromEnv;
  try {
    // 本地安装（开发模式）
    return require.resolve("@earendil-works/pi-coding-agent/dist/index.js");
  } catch {}
  // 全局安装多候选探测（2026-09-09：NPM_CONFIG_PREFIX 被污染指向 Program Files\nodejs 时
  // npm root -g 返回错误路径，包实际在默认位置 %APPDATA%\npm\node_modules）
  const { execSync } = require("node:child_process");
  const rel = path.join("@earendil-works", "pi-coding-agent", "dist", "index.js");
  const roots = [];
  // node.exe 同级的 node_modules：NPM_CONFIG_PREFIX 指向 node 安装目录时的全局落点。
  // 2026-09-14 事故：本机 NPM_CONFIG_PREFIX=C:\Program Files\nodejs，全局包装在这里；
  // 但 watchdog 由计划任务启动，它的 env 里没有 NPM_CONFIG_PREFIX →
  // 「npm root -g」会随 cwd 漂移到 <cwd>\node_modules → 全部探测 miss → piPackage=""
  // → server.mjs 的 import(pathToFileURL("")) 解析成目录导入，启动即
  // ERR_UNSUPPORTED_DIR_IMPORT 崩溃，且 watchdog 永远拉不起来。
  // 这条探测不依赖任何环境变量，放最前面。
  roots.push(path.join(path.dirname(process.execPath), "node_modules"));
  // cwd 固定到仓库根：npm root -g 在无 prefix 时会按 cwd 的 package 上下文漂移
  try { roots.push(execSync("npm root -g", { encoding: "utf8", cwd: __dirname }).trim()); } catch {}
  if (process.platform === "win32" && process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  }
  roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
  for (const root of roots) {
    if (!root) continue;
    const full = path.join(root, rel);
    try { if (fs.existsSync(full)) return full; } catch {}
  }
  return "";
}

// 默认工作空间：优先已存在的 pi-workspace（多盘符探测，兼容 C/D 盘部署）；否则退回启动目录
function defaultCwd() {
  // 常见位置：D:\pi-workspace（本机真实工作空间）> 主目录/pi-workspace > 启动目录
  return defaultWorkspace();
}

export const CONFIG = {
  port: parseInt(env("PORT") || "8787", 10),
  // 默认仅监听本机；需要手机直接通过局域网 IP 连接时显式设置 YUANSHU_LAN=1。
  host: env("HOST") || (env("LAN") === "1" ? "0.0.0.0" : "127.0.0.1"),
  corsOrigins: env("CORS_ORIGINS") || "",
  token: loadToken(),
  tokenFile: TOKEN_FILE,
  // 工作目录：优先环境变量；默认主目录/pi-workspace（跨平台，不硬编码）
  cwd: env("CWD") || defaultCwd(),
  // 允许的工具集，逗号分隔
  tools: (env("TOOLS") || "read,write,edit,bash").split(",").map(s => s.trim()).filter(Boolean),
  // 默认模型，空 = 使用第一个可用模型
  model: env("MODEL") || "zhipu-paid/glm-5.3-flash", // 2026-08-31 默认主力切智谱付费 glm-5.3-flash（env YUANSHU_MODEL 可覆盖）
  // 外部思考调试开关（externalThinking）：给模型挂 think 工具导出推理草稿（默认关）
  externalThinking: env("EXTERNAL_THINKING") === "1",
  // 兼容适配器包路径（跨平台推导）
  piPackage: resolvePiPackage(),
};
