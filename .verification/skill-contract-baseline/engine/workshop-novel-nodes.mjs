// 小说管道节点目录（novel-forge-v10）：产品化 → 五层 → 真相 → 写章 → 修订 → 导出
export const PIPELINE_NODES = [
  { id: "product", phase: "产品化", label: "产品化", file: "product.md", kind: "md", generate: true },
  { id: "voice", phase: "五层", label: "叙事声音", file: "layers/voice.md", kind: "md", generate: true },
  { id: "world", phase: "五层", label: "世界观", file: "layers/world.md", kind: "md", generate: true },
  { id: "characters", phase: "五层", label: "人物", file: "layers/characters.md", kind: "md", generate: true },
  { id: "outline", phase: "五层", label: "大纲", file: "layers/outline.md", kind: "md", generate: true },
  { id: "canon", phase: "五层", label: "硬事实", file: "truth/canon.md", kind: "md", generate: true },
  { id: "state", phase: "真相", label: "世界状态", file: "truth/current_state.json", kind: "json" },
  { id: "hooks", phase: "真相", label: "伏笔", file: "truth/pending_hooks.json", kind: "json" },
  { id: "ledger", phase: "真相", label: "资源账本", file: "truth/particle_ledger.json", kind: "json" },
  { id: "subplots", phase: "真相", label: "支线", file: "truth/subplot_board.json", kind: "json" },
  { id: "arcs", phase: "真相", label: "情感弧", file: "truth/emotional_arcs.json", kind: "json" },
  { id: "matrix", phase: "真相", label: "信息边界", file: "truth/character_matrix.json", kind: "json" },
  { id: "summaries", phase: "真相", label: "章摘要", file: "truth/chapter_summaries.json", kind: "json" },
  { id: "write", phase: "写作", label: "写章", file: null, kind: "write" },
  { id: "revise", phase: "修订", label: "修订", file: null, kind: "revise" },
  { id: "export", phase: "导出", label: "导出", file: "export.md", kind: "export" },
];

const JSON_EMPTY = {
  "truth/current_state.json": { locations: {}, characters: {}, status: "待构建" },
  "truth/pending_hooks.json": [],
  "truth/particle_ledger.json": { items: [], currency: {}, notes: "（待构建）" },
  "truth/subplot_board.json": [],
  "truth/emotional_arcs.json": [],
  "truth/character_matrix.json": {},
  "truth/chapter_summaries.json": [],
};

export const FOUNDATION_NODES = ["product", "voice", "world", "characters", "outline", "canon"];

export function findNode(id) {
  return PIPELINE_NODES.find(n => n.id === id) || null;
}

export function nodeTemplate(node, meta = {}) {
  if (!node?.file) return "";
  if (node.kind === "json") {
    const body = JSON_EMPTY[node.file];
    return JSON.stringify(body ?? {}, null, 2) + "\n";
  }
  const title = meta.title ? `《${meta.title}》` : "本书";
  const who = meta.protagonist || "（待定）";
  const world = meta.setting || "（待定）";
  const heads = {
    "product.md": `# 产品化\n\n- 市场：\n- 读者画像：\n- 一句话卖点：\n- 差异化：\n\n（待构建）\n`,
    "layers/voice.md": `# 叙事声音\n\n- 人称：${meta.narrator || "第三人称"}\n- 文风：\n- 语气：\n\n（待构建）\n`,
    "layers/world.md": `# 世界观\n\n${world}\n\n（待构建）\n`,
    "layers/characters.md": `# 人物\n\n## 主角\n- ${who}\n\n（待构建）\n`,
    "layers/outline.md": `# 大纲与伏笔\n\n（待构建）\n`,
    "truth/canon.md": `# 硬事实库（不可违背）\n\n## 主角\n- ${who}\n\n## 世界\n- ${world}\n\n（待构建）\n`,
    "export.md": `# ${title}\n\n（尚未导出）\n`,
  };
  return heads[node.file] || `# ${node.label}\n\n（待构建）\n`;
}

export function isNodeReady(node, content, chapterCount = 0) {
  if (node.kind === "write" || node.kind === "revise") return chapterCount > 0;
  const t = String(content || "").trim();
  if (!t) return false;
  if (t.includes("（待构建）") || t.includes("（尚未导出）") || t.includes("待构建")) return false;
  return t.length > 8;
}
