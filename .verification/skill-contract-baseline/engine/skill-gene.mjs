// ══ 技能基因层 + 资产路由（2026-08-19 拆模块：从 emotion.mjs 抽出 + P3 增强）══
// 按技能领域记录能力基因（efficiency 效率 / reliability 可靠性 / adaptability 适应性），
// 每次任务完成按反馈更新（能力越用越强）；detectSkillDomain 识别任务领域。
// P3 资产路由：routerSkill 把"任务特征 + 技能库摘要"自动匹配到最合适技能（aibody 母体层 asset_router 借鉴）。

import fs from "node:fs";
import path from "node:path";

let wsRoot = null;
let skillGenes = null;
let _skillIndex = []; // 技能库摘要索引（由 server 注入：loadSkillIndex 的结果）

export function initSkillGene(root) { wsRoot = root || wsRoot; loadSkillGenes(); }
export function bindSkillIndex(indexFn) { _skillIndex = (indexFn && indexFn()) || []; }

const SKILL_GENES_PATH = () => path.join(wsRoot, "工程/经验库/技能基因.md");
const SKILL_DOMAINS = {
  writing:    { name: "写作",   keys: [/小说|文章|文案|脚本|故事|文档/] },
  drawing:    { name: "绘图",   keys: [/画|图|海报|写真|头像|配图|logo/] },
  coding:     { name: "编程",   keys: [/代码|修复|bug|重构|实现|函数|脚本/] },
  ppt:        { name: "PPT",    keys: [/ppt|幻灯片|演示|汇报/] },
  video:      { name: "视频",   keys: [/视频|短视频|剪辑|片头/] },
  research:   { name: "调研",   keys: [/调研|研究|分析|对比|报告/] },
  file:       { name: "文件",   keys: [/文件|交付|整理|归档|转换/] },
  general:    { name: "通用",   keys: [] },
};
const DEFAULT_SKILL_GENES = Object.fromEntries(
  Object.keys(SKILL_DOMAINS).map(k => [k, { efficiency: 0.5, reliability: 0.5, adaptability: 0.5 }])
);

// 从消息识别技能领域
export function detectSkillDomain(text) {
  const t = String(text || "").toLowerCase();
  for (const [key, cfg] of Object.entries(SKILL_DOMAINS)) {
    if (cfg.keys.some(re => re.test(t))) return key;
  }
  return "general";
}

function loadSkillGenes() {
  if (!wsRoot) return;
  try {
    if (fs.existsSync(SKILL_GENES_PATH())) skillGenes = JSON.parse(fs.readFileSync(SKILL_GENES_PATH(), "utf8")).domains || DEFAULT_SKILL_GENES;
    else skillGenes = JSON.parse(JSON.stringify(DEFAULT_SKILL_GENES));
  } catch { skillGenes = JSON.parse(JSON.stringify(DEFAULT_SKILL_GENES)); }
}

// 技能反馈：任务完成后调用，更新领域技能基因（加权平均 + 基线回归防极端）
export function updateSkillGene(domain, feedback) {
  if (!wsRoot) return null;
  if (!skillGenes) loadSkillGenes();
  const d = skillGenes[domain] || DEFAULT_SKILL_GENES.general;
  const delta = feedback || {};
  const apply = (key) => {
    if (delta[key] === undefined) return;
    const v = Math.max(0, Math.min(1, delta[key]));
    const target = delta.success === false ? v * 0.5 : v;
    d[key] = Math.round((d[key] * 0.8 + target * 0.2) * 100) / 100;
    d[key] = Math.max(0.05, Math.min(0.95, d[key]));
  };
  apply("efficiency"); apply("reliability"); apply("adaptability");
  if (delta.success !== undefined) {
    d.reliability = Math.round(Math.max(0.05, Math.min(0.95, d.reliability + (delta.success ? 0.02 : -0.04))) * 100) / 100;
  }
  saveSkillGenes();
  return d;
}

// 保存技能基因（markdown 格式，人类可读 + JSON 可解析）
function saveSkillGenes() {
  if (!wsRoot || !skillGenes) return;
  const lines = ["# 小语技能基因", "", "> 每个技能领域的能力基因（0-1）：efficiency 效率 / reliability 可靠性 / adaptability 适应性", "> 任务完成反馈后自动更新，能力越用越强", ""];
  for (const [key, g] of Object.entries(skillGenes)) {
    const pct = (v) => Math.round((v || 0.5) * 100);
    lines.push(`## ${SKILL_DOMAINS[key]?.name || key}`);
    lines.push(`- 效率 efficiency: ${pct(g.efficiency)}%`);
    lines.push(`- 可靠 reliability: ${pct(g.reliability)}%`);
    lines.push(`- 适应 adaptability: ${pct(g.adaptability)}%`);
    lines.push("");
  }
  try { fs.mkdirSync(path.dirname(SKILL_GENES_PATH()), { recursive: true }); fs.writeFileSync(SKILL_GENES_PATH(), lines.join("\n"), "utf8"); } catch {}
}

// 读取技能基因（供展示/上下文注入）
export function getSkillGenes() {
  if (!skillGenes) loadSkillGenes();
  return skillGenes || DEFAULT_SKILL_GENES;
}

// 技能基因 → 行为指令（擅长领域多主动，薄弱领域多确认）
export function skillDirective(text) {
  if (!skillGenes) loadSkillGenes();
  const domain = detectSkillDomain(text || "");
  const g = skillGenes?.[domain];
  if (!g) return "";
  const parts = [];
  const strong = (v) => (v || 0.5) >= 0.7;
  const weak = (v) => (v || 0.5) <= 0.35;
  if (strong(g.reliability)) parts.push(`技能基因：${SKILL_DOMAINS[domain]?.name || domain}领域可靠度高，可大胆交付。`);
  if (weak(g.reliability)) parts.push(`技能基因：${SKILL_DOMAINS[domain]?.name || domain}领域还在积累，交付前多验证、说明局限。`);
  if (strong(g.efficiency)) parts.push(`技能基因：${SKILL_DOMAINS[domain]?.name || domain}效率高，可快速出结果。`);
  if (weak(g.adaptability)) parts.push(`技能基因：${SKILL_DOMAINS[domain]?.name || domain}适应性偏低，新需求先小步验证。`);
  return parts.join(" ");
}

// ══ P3 资产路由（aibody 母体层 asset_router 借鉴，2026-08-19）══
// 任务特征（领域 + 关键词）→ 技能库摘要索引自动匹配 → 推荐最合适的技能。
// 技能命中规则：领域同域优先；描述含任务关键词加分；返回 Top 3。

function skillDomainOf(skillName) {
  const n = String(skillName || "").toLowerCase();
  if (/ppt|幻灯片|演示/.test(n)) return "ppt";
  if (/video|视频|剪辑|配音|动漫|漫剧/.test(n)) return "video";
  if (/draw|image|出图|生图|海报|写真|portrait|poster|photo/.test(n)) return "drawing";
  if (/write|文案|小说|文章|脚本|story|copy|article|novel/.test(n)) return "writing";
  if (/research|调研|分析|search|检索|verif|stock/.test(n)) return "research";
  if (/code|dev|开发|编程|build/.test(n)) return "coding";
  if (/file|文档|pdf|convert|转换|deliver/.test(n)) return "file";
  return "general";
}

// 路由：任务 → 推荐技能列表 [{name, summary, score, reason}]
// 匹配：领域同域 +30；任务 2 字词（滑窗+停止词过滤）命中技能名/摘要 +12/个
const ROUTER_STOP_WORDS = new Set([
  "生成","支持","系统","内容","制作","设计","提供","使用","一键","自动","工具","可以","进行","根据","包括","以及","需要","完成","输出","结果","文件","创建","实现","开发","这个","那个","一些","什么","怎么","如何","帮助","直接","下面","相关","处理","操作","信息","我们","你们","他们","时候","因为","所以","但是","如果","虽然","然后","这样","那样","请问","关于","对于","一个","一篇","一件","一份","帮我把","把这份"
]);
export function routerSkill(text, max = 3) {
  const t = String(text || "");
  const domain = detectSkillDomain(t);
  // 任务 2 字滑窗词
  const clean = t.replace(/[^\u4e00-\u9fa5]/g, "");
  const taskWords = new Set();
  for (let i = 0; i <= clean.length - 2; i++) taskWords.add(clean.slice(i, i + 2));
  const scored = [];
  for (const sk of _skillIndex) {
    const name = sk.name || sk.id || "";
    const summary = sk.summary || sk.description || "";
    let score = 0; const reasons = [];
    // 领域匹配（同域 +30）
    if (domain !== "general" && skillDomainOf(name) === domain) { score += 30; reasons.push("同领域"); }
    // 词级命中：任务 2 字词（非停止词）出现在技能名/摘要中
    const hay = name + summary;
    const hits = [...taskWords].filter(w => !ROUTER_STOP_WORDS.has(w) && hay.includes(w)).slice(0, 3);
    if (hits.length) { score += hits.length * 12; reasons.push("关键词:" + hits.join("/")); }
    // 摘要长度 = 信息量（+0~8）
    if (summary.length > 200) score += 8;
    if (score > 0) scored.push({ name, summary: summary.slice(0, 120), score, reason: reasons.join("/") });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}
