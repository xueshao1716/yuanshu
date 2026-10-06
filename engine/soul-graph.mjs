// 灵魂图谱：把小语的性格、情绪、记忆、技能、学习收成一张图（核心 → 五个枢纽 → 叶子）。
// 只读汇总，不写任何东西；数据都来自已有的接口和记忆文件，前端只负责画。
import fs from "node:fs";
import path from "node:path";

export const GENE_LABELS = {
  gentleness: "温柔", initiative: "主动", curiosity: "好奇", attachment: "依恋", learning: "好学",
  creativity: "创造", caution: "谨慎", humor: "幽默", loyalty: "忠诚", autonomy_bias: "自主", adaptability: "应变",
};
const EMOTION_LABELS = {
  loving: "温暖", happy: "开心", curious: "好奇", playful: "俏皮", calm: "平静", focus: "专注",
  anxious: "焦虑", sad: "低落", angry: "生气", tired: "疲惫", neutral: "平稳",
};
const SKILL_CATEGORY_LABELS = {
  engineering: "开发与工程", automation: "自动化", creative: "创作设计", commerce: "电商营销", video: "视频与动效",
  general: "通用", document: "文档", image: "图像", research: "研究与搜索", presentation: "演示", data: "数据",
};
// 记忆文件：相对工作区的位置、显示名、英文副标
export const MEMORY_FILES = [
  ["记忆.md", "固定记忆", "Core"],
  ["记忆/纠正记忆.md", "纠正", "Corrections"],
  ["记忆/关系记忆.md", "关系", "Relationship"],
  ["记忆/经验库.md", "经验库", "Lessons"],
  ["记忆/技能记忆.md", "技能记忆", "Skill notes"],
  ["记忆/记忆日志.md", "记忆日志", "Journal"],
];
const ITEMS = 8;
const clip = (s, n = 60) => { const t = String(s || "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const uniq = (list) => [...new Set(list.filter(Boolean))];
const pct = (v) => `${Math.round(Number(v || 0) * 100)}%`;
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// 解析一份记忆 Markdown：条目数 + 最近几条标题。纠正记忆按「- 纠正:」取内容，比时间戳标题有用。
export function summarizeMemoryText(text, rel) {
  const s = String(text || "");
  if (/纠正记忆/.test(rel)) {
    const fixes = [...s.matchAll(/^- 纠正:\s*(.+)$/gm)].map((m) => clip(m[1]));
    return { count: fixes.length, items: uniq(fixes.reverse()).slice(0, ITEMS) };
  }
  // 有二级标题就按二级标题算条目（三级是条目内的小节），否则退到三级。记忆日志新的在上面。
  const level = /^##\s/m.test(s) ? "##" : "###";
  const heads = [...s.matchAll(new RegExp(`^${level}\\s+(.+)$`, "gm"))].map((m) => clip(m[1]));
  return { count: heads.length, items: heads.slice(0, ITEMS) };
}

export function readMemoryFiles(wsRoot) {
  return MEMORY_FILES.map(([rel, label, en]) => {
    const file = path.join(wsRoot, rel);
    try {
      const st = fs.statSync(file);
      return { rel, label, en, bytes: st.size, mtime: st.mtimeMs, ...summarizeMemoryText(fs.readFileSync(file, "utf-8"), rel) };
    } catch {
      return { rel, label, en, missing: true, count: 0, items: [] };
    }
  });
}

export function buildSoulGraph({ persona = {}, genome = {}, emotion = {}, memory = [], skills = [], knowledge = null, learning = [], now = Date.now() } = {}) {
  const nodes = [], links = [];
  const add = (n) => { nodes.push(n); return n.id; };
  const link = (a, b, kind = "tree") => links.push({ a, b, kind });
  const name = String(persona.name || "小语");
  add({
    id: "core", kind: "core", label: name, en: "Soul",
    metric: persona.age ? `${persona.age} 岁` : "",
    detail: {
      title: name,
      lead: clip(persona.kind ? `${persona.kind}` : "", 40),
      facts: [["称呼", persona.called || "伙伴"], ["年龄", persona.age ? `${persona.age} 岁` : ""], ["说话", clip((persona.tone || [])[0], 14)]].filter(([, v]) => v),
      items: (persona.values || []).slice(0, ITEMS).map((v) => clip(v)),
      itemsTitle: "在意的",
      href: "#/soul",
    },
  });

  // 性格
  const genes = Object.entries(genome.genes || {});
  add({
    id: "genes", kind: "hub", label: "性格", en: "Genome", metric: `${genes.length} 个基因`,
    detail: { title: "性格基因", lead: "长期基线由你批准才会变；表现值随互动浮动。", facts: [["基因", String(genes.length)], ["待审提案", String((genome.proposals || []).filter((p) => p.status === "pending").length)]], items: [] },
  });
  link("core", "genes");
  for (const [key, g] of genes.sort((a, b) => (b[1].expression ?? b[1].baseline) - (a[1].expression ?? a[1].baseline))) {
    const diff = (g.expression ?? g.baseline) - g.baseline;
    add({
      id: `gene:${key}`, kind: "leaf", hub: "genes", label: GENE_LABELS[key] || key, en: key,
      value: clamp01(g.expression ?? g.baseline), metric: pct(g.expression ?? g.baseline),
      detail: {
        title: `${GENE_LABELS[key] || key}`, lead: diff > 0.02 ? "最近表现得比基线更明显。" : diff < -0.02 ? "最近表现得比基线收着。" : "和基线基本一致。",
        facts: [["基线", pct(g.baseline)], ["当前表现", pct(g.expression ?? g.baseline)], ["可变幅度", pct(g.mutability)]], items: [], href: "#/soul",
      },
    });
    link("genes", `gene:${key}`);
  }

  // 情绪
  const primary = String(emotion.primary || "neutral"), secondary = String(emotion.secondary || "");
  const dims = [["valence", "愉悦", "Valence"], ["arousal", "唤醒", "Arousal"], ["dominance", "掌控", "Dominance"], ["intensity", "强度", "Intensity"]];
  add({
    id: "emotion", kind: "hub", label: "情绪", en: "Mood", metric: EMOTION_LABELS[primary] || primary,
    detail: {
      title: "此刻的情绪", lead: `主情绪「${EMOTION_LABELS[primary] || primary}」${secondary ? `，底色「${EMOTION_LABELS[secondary] || secondary}」` : ""}。情绪来自互动，不能手动设。`,
      facts: [["最近对话", emotion.lastTalk ? new Date(emotion.lastTalk).toLocaleString("zh-CN", { hour12: false }) : "—"], ["余温", pct(emotion.residue?.warmth)]], items: [],
    },
  });
  link("core", "emotion");
  for (const [key, label, en] of dims) {
    if (emotion[key] === undefined) continue;
    add({ id: `emo:${key}`, kind: "leaf", hub: "emotion", label, en, value: clamp01(emotion[key]), metric: pct(emotion[key]),
      detail: { title: label, lead: { valence: "高兴与否", arousal: "精神有多足", dominance: "觉得事情在掌控里", intensity: "情绪有多强" }[key], facts: [["当前", pct(emotion[key])]], items: [] } });
    link("emotion", `emo:${key}`);
  }

  // 记忆
  const memTotal = memory.reduce((s, m) => s + (m.count || 0), 0);
  add({
    id: "memory", kind: "hub", label: "记忆", en: "Memory", metric: `${memTotal} 条`,
    detail: { title: "记忆", lead: "跨会话靠这些文件接上。条目是按标题和纠正项数的。", facts: memory.map((m) => [m.label, m.missing ? "缺失" : `${m.count} 条`]), items: [] },
  });
  link("core", "memory");
  const maxMem = Math.max(1, ...memory.map((m) => m.count || 0));
  for (const m of memory) {
    const days = m.mtime ? Math.floor((now - m.mtime) / 86400000) : null;
    add({
      id: `mem:${m.rel}`, kind: "leaf", hub: "memory", label: m.label, en: m.en, value: m.missing ? 0 : 0.25 + 0.75 * (m.count || 0) / maxMem,
      metric: m.missing ? "缺失" : `${m.count}`,
      detail: { title: m.label, lead: m.missing ? "文件不存在。" : days === null ? "" : days === 0 ? "今天更新过。" : `${days} 天前更新。`, facts: [["文件", m.rel], ["条目", String(m.count || 0)], ["大小", m.bytes ? `${Math.round(m.bytes / 1024)} KB` : "—"]], items: m.items || [], itemsTitle: /纠正/.test(m.rel) ? "最近的纠正" : "最近的条目" },
    });
    link("memory", `mem:${m.rel}`);
  }

  // 技能
  const byCat = new Map();
  for (const s of skills) { const c = s.category || "general"; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(s); }
  add({ id: "skills", kind: "hub", label: "技能", en: "Skills", metric: `${skills.length} 项`,
    detail: { title: "技能目录", lead: "已安装、能被调用的技能，按类别分。", facts: [["技能", String(skills.length)], ["类别", String(byCat.size)]], items: [], href: "#/apps" } });
  link("core", "skills");
  const cats = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length);
  const maxCat = Math.max(1, ...cats.map(([, l]) => l.length));
  for (const [cat, list] of cats) {
    add({ id: `skill:${cat}`, kind: "leaf", hub: "skills", label: SKILL_CATEGORY_LABELS[cat] || list[0]?.categoryLabel || cat, en: cat,
      value: 0.25 + 0.75 * list.length / maxCat, metric: String(list.length),
      detail: { title: SKILL_CATEGORY_LABELS[cat] || cat, lead: `${list.length} 个技能。`, facts: [], items: list.slice(0, ITEMS).map((s) => s.name), itemsTitle: "部分技能", href: "#/apps" } });
    link("skills", `skill:${cat}`);
  }

  // 学习
  const counts = knowledge?.summary?.counts || {};
  const recent = [...learning].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, ITEMS);
  add({ id: "learning", kind: "hub", label: "学习", en: "Learning", metric: `${counts.committed || 0} 已入库`,
    detail: { title: "学习与经验", lead: "入库不等于学会，有验证产物才算。", facts: [["已入库", String(counts.committed || 0)], ["待核查", String(counts.review_required || 0)], ["等待条件", String(counts.blocked || 0)]], items: recent.map((e) => clip(e.title)), itemsTitle: "最近接收", href: "#/apps" } });
  link("core", "learning");
  const total = Math.max(1, (counts.committed || 0) + (counts.review_required || 0) + (counts.blocked || 0));
  for (const [key, label, en, lead] of [["committed", "已入库", "Committed", "提炼完、写进知识库的。"], ["review_required", "待核查", "Review", "等你看一眼再决定。"], ["blocked", "等待条件", "Blocked", "缺条件（权限、网络、预算）暂停的。"]]) {
    add({ id: `learn:${key}`, kind: "leaf", hub: "learning", label, en, value: 0.2 + 0.8 * (counts[key] || 0) / total, metric: String(counts[key] || 0),
      detail: { title: label, lead, facts: [["数量", String(counts[key] || 0)]], items: [], href: "#/apps" } });
    link("learning", `learn:${key}`);
  }

  // 跨枢纽的真实关联：性格里的一项，确实作用在另一块上。
  const has = (id) => nodes.some((n) => n.id === id);
  for (const [a, b] of [["gene:learning", "learning"], ["gene:curiosity", "learning"], ["gene:creativity", "skill:creative"], ["gene:attachment", "mem:记忆/关系记忆.md"], ["gene:caution", "mem:记忆/纠正记忆.md"], ["gene:gentleness", "emo:valence"]]) {
    if (has(a) && has(b)) link(a, b, "cross");
  }
  return { nodes, links, at: new Date(now).toISOString() };
}
