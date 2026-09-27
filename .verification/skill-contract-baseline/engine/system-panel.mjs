// ══════════════════════════════════════════════════════════
// engine/system-panel.mjs —— 系统面板（08-26）：能力清单 / 信息聚合 / 外网配置持久化
// 外网配置存 AGENT_DIR/system-network.json（可编辑：公网域名列表），NomiFun 设置页风格。
// ══════════════════════════════════════════════════════════
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { atomicWriteJson } from "./atomic-io.mjs";

const STARTED_AT = Date.now();

// 默认外网域名（首次生成配置文件用；之后以用户编辑的为准）
const DEFAULT_DOMAINS = [
  { domain: "pi.myxinyu.xin", desc: "工作台主入口" },
  { domain: "share.myxinyu.xin", desc: "成品外链分享" },
  { domain: "novel.myxinyu.xin", desc: "小说创作系统" },
];

// 功能一览（系统页展示；新增功能时在此登记）。
// 注意别叫「系统能力」：主栏的「能力」是引擎运行时页（引擎配置/工具目录/运行诊断），
// 和这份硬编码的功能自述毫无关系，同名会让人以为两个页面重复（2026-09-14 实际踩到）。
export const SYSTEM_CAPABILITIES = [
  { icon: "chat", name: "多会话对话", desc: "流式输出 · 多端实时同步 · 语音输入 · 轮次折叠 · 模型参数调节" },
  { icon: "sparkles", name: "灵犀灵感池", desc: "伙伴与小语分源速记灵感，攒着一起评审采纳" },
  { icon: "clock", name: "任务中心", desc: "定时任务调度 · 手动执行 · 运行历史" },
  { icon: "factory", name: "专项工作台", desc: "AI 绘画 · 视频工坊 · PPT 生成 · 小说工坊，成品自动入库" },
  { icon: "image", name: "资产库", desc: "生成物/交付物统一管理 · 类型筛选 · 在线预览下载" },
  { icon: "brain", name: "模型中心", desc: "多通道接入 · 免费标注 · Auto 智能路由 · 会话级参数" },
  { icon: "flask", name: "应用中心", desc: "经验沉淀台 · 技能库 · 提示词库 · 改进提案" },
  { icon: "sprout", name: "记忆园丁", desc: "重复/过时记忆扫描 · 人工核对去重（带备份）" },
  { icon: "terminal", name: "终端面板", desc: "Code Mode REPL · 工作空间文件浏览 · 活动流" },
  { icon: "globe", name: "多端访问", desc: "公网域名 · 局域网直连 · 安卓 APK 壳" },
];

function networkPath(agentDir) {
  return path.join(agentDir, "system-network.json");
}

/** 读外网配置；无文件或损坏时返回默认并落盘 */
export function loadNetworkConfig(agentDir, fsMod = fs) {
  const p = networkPath(agentDir);
  try {
    const d = JSON.parse(fsMod.readFileSync(p, "utf8"));
    if (Array.isArray(d?.domains)) return d;
  } catch {}
  const def = { version: 1, domains: DEFAULT_DOMAINS };
  try { saveNetworkConfig(agentDir, def, fsMod); } catch {}
  return def;
}

/** 保存外网配置（domains: [{domain, desc}]）*/
export function saveNetworkConfig(agentDir, config, fsMod = fs) {
  const domains = (config?.domains || [])
    .map(d => ({ domain: String(d.domain || "").trim().toLowerCase(), desc: String(d.desc || "").trim() }))
    .filter(d => d.domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d.domain));
  if (!domains.length && config?.domains?.length) return { error: "没有有效的域名条目" };
  const out = { version: 1, domains, updatedAt: new Date().toISOString() };
  atomicWriteJson(networkPath(agentDir), out, fsMod);
  return { ok: true, domains };
}

/** 系统信息聚合（含外网配置） */
export function systemInfo(wsRoot, agentDir, fsMod = fs) {
  // 版本唯一来源是仓库根 version.json。
  // 之前这里扫 package.json，读到的是壳版本 0.2.4，而看板读 APP_VERSION 是 2.7.1——
  // 同一套系统里两个数字都叫「版本」，用户自然觉得"版本号一直不动"。
  // 现在两边同源。version.json 找不到时才回退扫 package.json（老安装可能没这文件）。
  let version = "";
  const versionFile = path.join(import.meta.dirname, "..", "version.json");
  try {
    const v = JSON.parse(fsMod.readFileSync(versionFile, "utf8"));
    if (v?.version) version = String(v.version);
  } catch {}
  if (!version) {
    // AGENT_DIR 通常是 Pi 的用户目录，不一定包含工作台自身的 package.json。
    // 优先读取运行时目录，找不到时回退到工作区/本模块所在仓库。
    const packageRoots = [agentDir, wsRoot, path.join(import.meta.dirname, "..")]
      .filter(Boolean)
      .filter((dir, i, all) => all.indexOf(dir) === i);
    for (const root of packageRoots) {
      try {
        const candidate = JSON.parse(fsMod.readFileSync(path.join(root, "package.json"), "utf8"));
        if (candidate?.version) { version = String(candidate.version); break; }
      } catch {}
    }
  }
  const net = loadNetworkConfig(agentDir, fsMod);
  const lanIPs = [];
  try {
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const n of nets || []) if (n.family === "IPv4" && !n.internal) lanIPs.push(n.address);
    }
  } catch {}
  return {
    name: "元枢个人智能系统",
    version,
    node: process.version,
    platform: `${os.type()} ${os.arch()}`,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    startedAt: new Date(STARTED_AT).toISOString(),
    wsRoot,
    port: 8787,
    capabilities: SYSTEM_CAPABILITIES,
    network: { domains: net.domains, lanIPs },
  };
}

/** 检测更新：本地 git HEAD vs 远端仓库最新提交（GitHub→Gitee 双源回退） */
export async function checkUpdate(repoDir, fsMod = fs) {
  let localShaFull = "";
  try { localShaFull = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, timeout: 5000 }).toString().trim(); } catch {}
  const localSha = localShaFull.slice(0, 7);
  const sources = [
    { name: "github", url: "https://api.github.com/repos/xueshao1716/yuanshu/commits/main",
      pick: (d) => ({ sha: String(d.sha || "").slice(0, 7), message: String(d.commit?.message || "").split("\n")[0], date: d.commit?.author?.date }) },
    { name: "gitee", url: "https://gitee.com/api/v5/repos/linxinyu520xue/yuanshu/branches/main",
      pick: (d) => ({ sha: String(d.commit?.id || "").slice(0, 7), message: String(d.commit?.message || "").split("\n")[0], date: undefined }) },
  ];
  let lastErr = null;
  for (const s of sources) {
    try {
      const resp = await fetch(s.url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "pi-web" } });
      if (!resp.ok) { lastErr = new Error(`${s.name} 返回 ${resp.status}`); continue; }
      const remote = s.pick(await resp.json());
      if (!remote.sha) continue;
      return { ok: true, source: s.name, localSha, remote, upToDate: !localShaFull || localSha === remote.sha };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, error: "无法连接 github / gitee：" + (lastErr?.message || "网络不可达"), localSha };
}
