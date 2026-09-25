// engine/refine-api.mjs —— 经验沉淀台（refine 提案制，Prime Agent 移植）（2026-08-20 从 server.mjs 拆出）
// 依赖注入：initRefineApi({ cwd }）；emotion 基因系统直接 import（同 engine 目录）
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { json } from "./http-utils.mjs";
import * as emotion from "./emotion.mjs";

let _cwd = "";
export function initRefineApi({ cwd = "" } = {}) { _cwd = cwd; }

// 将 Python/上游错误压成可操作的中文提示，避免把无关堆栈直接展示给用户。
export function formatRefineError(raw) {
  const text = String(raw || "").trim();
  if (/\b402\b|Payment Required|insufficient balance|余额不足|quota/i.test(text)) return "上游模型额度不足（HTTP 402）。已确认 DeepSeek 当前不可用，请补充额度或切换可用模型后重试。";
  if (/\b401\b|Unauthorized|invalid.*key|认证/i.test(text)) return "上游模型认证失败（HTTP 401）。请检查模型凭证。";
  if (/timed? ?out|timeout|超时/i.test(text)) return "上游模型请求超时。请稍后重试或切换模型。";
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|URLError|网络/i.test(text)) return "上游模型网络不可达。请检查代理、域名和本机网络后重试。";
  const last = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
  return (last || "经验沉淀生成失败").slice(0, 240);
}

// ══ 经验沉淀台（refine 提案制，Prime Agent 移植）══
// 工具：工具/refine_proposal.py（plan/list/approve --only/reject/rollback/status）
// ⚠️ 路径必须用函数延迟求值：_cwd 由 initRefineApi 在运行时注入，若顶层用 const 立即求值，
//    import 时 _cwd 仍是 ""，会拼出相对路径 工程/经验库/...，而服务 cwd 是 D:/pi-web → 读到不存在的文件 → 网页一直空。
const REFINE_SCRIPT = () => path.join(_cwd, "工具", "refine_proposal.py");
const REFINE_PROPOSALS = () => path.join(_cwd, "工程", "经验库", "refine-proposals.json");
const REFINE_LOG = () => path.join(_cwd, "工程", "经验库", "refine-log.jsonl");
const EXPERIENCE_FILE = () => path.join(_cwd, "工程", "经验库", "experience.md");
const SKILL_GENE_FILE = () => path.join(_cwd, "工程", "经验库", "技能基因.md");

export function readRefineJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function runRefineScript(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let child, settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      resolve(result);
    };
    let out = "", err = "", to = null;
    try {
      child = spawn("python", [REFINE_SCRIPT(), ...args], { windowsHide: true });
    } catch (e) {
      return finish({ code: -1, out: "", err: String(e?.message || e) });
    }
    to = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ code: -1, out, err: `${err}\n执行超时（${Math.round(timeoutMs / 1000)} 秒）`.trim() });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish({ code: -1, out, err: String(e?.message || e) }));
    child.on("close", (code) => finish({ code, out, err }));
  });
}

export function handleRefineStatus(res) {
  const data = readRefineJson(REFINE_PROPOSALS(), { pending: [], applied: [], rejected: [] });
  let lastLog = null;
  try {
    const lines = fs.readFileSync(REFINE_LOG(), "utf8").trim().split("\n").filter(Boolean);
    if (lines.length) lastLog = JSON.parse(lines[lines.length - 1]);
  } catch {}
  let experience = { exists: false, updatedAt: null, entries: [], count: 0 };
  try {
    const file = EXPERIENCE_FILE();
    const md = fs.readFileSync(file, "utf8");
    const entries = [];
    const re = /^(##|###)\s+(.+)$/gm;
    let m;
    while ((m = re.exec(md))) entries.push({ level: m[1].length, title: m[2].trim(), index: m.index });
    experience = {
      exists: true,
      updatedAt: fs.statSync(file).mtime.toISOString(),
      count: entries.length,
      source: '工程/经验库/experience.md',
      entries: entries.slice(-500).reverse().map((entry) => {
        const next = entries.find((x) => x.index > entry.index)?.index ?? md.length;
        const body = md.slice(entry.index, next).split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
        return { title: entry.title, preview: body.slice(0, 180) };
      }),
    };
  } catch (error) { if (error.code !== 'ENOENT') experience.error = 'experience_unreadable'; }
  json(res, 200, {
    counts: { pending: data.pending?.length || 0, applied: data.applied?.length || 0, rejected: data.rejected?.length || 0 },
    lastLog,
    experience,
  });
}

export function handleRefineList(res) {
  const data = readRefineJson(REFINE_PROPOSALS(), { pending: [], applied: [], rejected: [] });
  json(res, 200, data);
}

// ══ 基因反馈：对已应用提案打分，驱动技能基因进化 ══
const DOMAIN_KEYWORDS = {
  "写作": ["写作", "文案", "剧本", "小说", "分镜", "提示词"],
  "绘图": ["绘图", "出图", "画像", "海报", "配图", "插图"],
  "编程": ["编程", "代码", "脚本", "工具", "自动化", "debug"],
  "视频": ["视频", "剪辑", "flvx", "flax", "flux", "转场", "配音"],
  "网页": ["网页", "前端", "html", "css", "界面", "布局", "ui"],
  "文档": ["文档", "文档整理", "归档", "方法论", "md"],
};
export function detectSkillDomain(text) {
  const s = String(text || "").toLowerCase();
  let best = null, bestHit = 0;
  for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    const hit = kws.filter(k => s.includes(k.toLowerCase())).length;
    if (hit > bestHit) { bestHit = hit; best = domain; }
  }
  return best || "通用";
}
export function handleRefineFeedback(res, body) {
  const { id, domain, scores } = body || {};
  if (!id || !scores) return json(res, 400, { error: "需要 id + scores" });
  const data = readRefineJson(REFINE_PROPOSALS(), { pending: [], applied: [], rejected: [] });
  const target = (data.applied || []).find(p => p.id === id);
  if (!target) return json(res, 404, { error: "未找到已应用提案" });
  const d = domain || detectSkillDomain(target.summary + " " + JSON.stringify(target.edits || []));
  // 读取技能基因.md 并更新该领域三维评分（滑动平均 0-100%）
  try {
    let md = fs.readFileSync(SKILL_GENE_FILE(), "utf8");
    const seed = { efficiency: 50, reliability: 50, adaptability: 50 }; // 默认
    const get = (line) => {
      const m = line.match(/^-\s*(效率|可靠|适应)\s+\w+\s*:\s*(\d+)%/);
      return m ? { k: m[1], v: parseInt(m[2], 10) } : null;
    };
    const update = (line, key, val) => line.replace(/(效率|可靠|适应)\s+\w+\s*:\s*\d+%/, `${key} ${key === "效率" ? "efficiency" : key === "可靠" ? "reliability" : "adaptability"}: ${val}%`);
    const lines = md.split("\n");
    let inDomain = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) inDomain = lines[i].includes(d);
      if (inDomain && get(lines[i])) {
        const { k, v } = get(lines[i]);
        const map = { "效率": "efficiency", "可靠": "reliability", "适应": "adaptability" };
        const key = map[k];
        const fb = scores[key] != null ? Number(scores[key]) : (scores[k] ?? v);
        const newVal = Math.round((v + fb) / 2); // 滑动平均
        lines[i] = update(lines[i], k, Math.max(0, Math.min(100, newVal)));
      }
    }
    fs.writeFileSync(SKILL_GENE_FILE(), lines.join("\n"), "utf8");
    // 记录反馈日志
    const logLine = JSON.stringify({ ts: new Date().toISOString(), id, domain: d, scores, from: "refine-feedback" }) + "\n";
    fs.appendFileSync(REFINE_LOG(), logLine);
    json(res, 200, { ok: true, domain: d, msg: `已更新「${d}」技能基因` });
  } catch (e) {
    json(res, 500, { error: "更新技能基因失败: " + (e?.message || e) });
  }
}
export function handleRefineGenes(res) {
  try {
    const md = fs.readFileSync(SKILL_GENE_FILE(), "utf8");
    const domains = {};
    let cur = null;
    for (const line of md.split("\n")) {
      if (line.startsWith("## ")) { cur = line.slice(3).trim(); domains[cur] = {}; continue; }
      if (cur) {
        const m = line.match(/^-\s*(效率|可靠|适应)\s+\w+\s*:\s*(\d+)%/);
        if (m) domains[cur][{ "效率": "efficiency", "可靠": "reliability", "适应": "adaptability" }[m[1]]] = parseInt(m[2], 10);
      }
    }
    json(res, 200, { domains });
  } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
}

export async function handleRefinePlan(res, body) {
  const args = ["plan", "--log", String(body?.log || 15)];
  if (body?.global) args.push("--global");
  if (body?.dryRun) args.push("--dry-run");
  if (body?.instructions) args.push("--instructions", String(body.instructions));
  const r = await runRefineScript(args, 240000);
  if (r.code !== 0) return json(res, 502, { error: formatRefineError(r.err || r.out || `python exit ${r.code}`), detail: r.err ? String(r.err).slice(-500) : undefined });
  const data = readRefineJson(REFINE_PROPOSALS(), { pending: [], applied: [], rejected: [] });
  const latest = data.pending?.length ? data.pending[data.pending.length - 1] : null;
  json(res, 200, { ok: true, latest, count: data.pending.length, log: r.out.slice(-600) });
}

export async function handleRefineApprove(res, body) {
  const args = ["approve", String(body?.id || "")];
  if (body?.only) args.push("--only", String(body.only));
  const r = await runRefineScript(args, 60000);
  if (r.code !== 0) return json(res, 500, { error: r.err || r.out || `python exit ${r.code}` });
  json(res, 200, { ok: true, log: r.out.trim() });
}

export async function handleRefineReject(res, body) {
  const args = ["reject", String(body?.id || "")];
  if (body?.reason) args.push("--reason", String(body.reason));
  const r = await runRefineScript(args, 60000);
  if (r.code !== 0) return json(res, 500, { error: r.err || r.out || `python exit ${r.code}` });
  json(res, 200, { ok: true, log: r.out.trim() });
}

export async function handleRefineRollback(res, body) {
  const args = ["rollback", String(body?.id || "")];
  const r = await runRefineScript(args, 60000);
  if (r.code !== 0) return json(res, 500, { error: r.err || r.out || `python exit ${r.code}` });
  json(res, 200, { ok: true, log: r.out.trim() });
}
