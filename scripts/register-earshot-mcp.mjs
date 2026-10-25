#!/usr/bin/env node
// 把 earshot 注册成元枢的 MCP 服务器（2026-10-25）
//
// 为什么用 MCP 而不是自己包一层：earshot 自带 `earshot mcp`，模型保持常驻、工具名和参数由它维护。
// 元枢这边已经有 MCP 客户端（engine/mcp-client.mjs，配置在 <工作区>/.yuanshu/mcp-servers.json），
// 注册进去，小语就多了一对耳朵：describe / match / find / timeline / critique / realness / measure…
//
// 用法：
//   node scripts/register-earshot-mcp.mjs                  # 自动找 earshot，写进工作区配置
//   node scripts/register-earshot-mcp.mjs --cli D:\earshot\.venv\Scripts\python.exe
//   node scripts/register-earshot-mcp.mjs --remove         # 拿掉
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadMcpConfig, saveMcpConfig, getMcpConfigPath } from "../engine/mcp-client.mjs";

const args = process.argv.slice(2);
const argOf = (n, d = "") => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const WS = argOf("ws", process.env.YUANSHU_WS || "D:\\pi-workspace");
const REMOVE = args.includes("--remove");
const NAME = "earshot";

const cfgPath = getMcpConfigPath(WS);

function findEarshot() {
  const explicit = argOf("cli", process.env.YUANSHU_EARSHOT || "");
  if (explicit) return explicit;
  // 1) PATH 里的 earshot
  try {
    const p = execFileSync(process.platform === "win32" ? "where" : "which", ["earshot"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    if (p) return p;
  } catch {}
  // 2) 常见 clone 位置的 venv
  const cands = [
    "D:\\earshot\\.venv\\Scripts\\python.exe",
    "D:\\earshot\\.venv\\Scripts\\earshot.exe",
    path.join(WS, "earshot", ".venv", "Scripts", "python.exe"),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return "";
}

const cfg = loadMcpConfig(WS);
cfg.servers = Array.isArray(cfg.servers) ? cfg.servers : [];

if (REMOVE) {
  const before = cfg.servers.length;
  cfg.servers = cfg.servers.filter((s) => s.name !== NAME);
  saveMcpConfig(WS, cfg);
  console.log(`已移除 ${NAME}（${before - cfg.servers.length} 条）｜配置：${cfgPath}`);
  process.exit(0);
}

const cli = findEarshot();
if (!cli) {
  console.log("没找到 earshot。先装：");
  console.log("  git clone https://github.com/Leonxlnx/earshot && cd earshot");
  console.log("  python -m venv .venv && .venv\\Scripts\\pip install torch --index-url https://download.pytorch.org/whl/cpu");
  console.log('  .venv\\Scripts\\pip install -e ".[mcp,llm,dev]"');
  console.log("  .venv\\Scripts\\python -m earshot doctor --load     # 预下载两个模型（~1.1GB）");
  console.log("然后重跑本脚本，或指定 --cli <python.exe 路径>");
  process.exit(2);
}

cfg.servers = cfg.servers.filter((s) => s.name !== NAME);
cfg.servers.push({
  name: NAME,
  command: cli,
  args: cli.toLowerCase().endsWith("python.exe") ? ["-m", "earshot", "mcp"] : ["mcp"],
  env: { EARSHOT_THREADS: String(Math.max(2, Math.min(4, Math.floor((process.env.NUMBER_OF_PROCESSORS || 8) / 2)))) },
  // 模型首次加载慢（20-40s），别让它被 5s 超时判死
  timeoutMs: 600000,
  note: "给 agent 的耳朵：听、比对、找片段、音画同步、真实度、交付评分（CPU-only）",
});

saveMcpConfig(WS, cfg);
console.log(`已注册 ${NAME} → ${cli}`);
console.log(`配置：${cfgPath}`);
console.log("重启服务后生效；工具会以 mcp_ 前缀出现在工具列表里。");
