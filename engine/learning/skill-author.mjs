// ===== skill-author.mjs —— 一句话造技能（2026-11-03）=====
//
// 她写一份 SKILL.md，这里负责：格式校验 → 落盘 → 可回滚。
// 校验不通过就不落盘（宁可让她重写，也不装一个空壳技能）。
import fs from "node:fs";
import path from "node:path";

export const SKILLS_REL = path.join("技能");
const REQUIRED = [
  { key: "when", label: "何时用", re: /^#{1,3}\s*何时用|何时使用|when to use/im },
  { key: "how", label: "怎么做", re: /^#{1,3}\s*怎么做|如何做|步骤|how to/im },
  { key: "boundary", label: "边界", re: /^#{1,3}\s*边界|不要|限制|boundary|edge/im },
];

export function validateSkillMd(text) {
  const t = String(text || "");
  const errors = [];
  if (t.trim().length < 200) errors.push(`内容太短（${t.trim().length} < 200 字），大概率是空壳`);
  if (!/^#\s+\S+/m.test(t)) errors.push("缺一级标题（技能名）");
  for (const r of REQUIRED) if (!r.re.test(t)) errors.push(`缺「${r.label}」小节`);
  if (/TODO|待补|占位/.test(t)) errors.push("含占位符（TODO/待补）");
  return { ok: errors.length === 0, errors };
}

export function skillDir(wsRoot, name) {
  return path.join(String(wsRoot || "."), SKILLS_REL, String(name || "").replace(/[\\/:*?"<>|]/g, "_"));
}

/** 安装技能：校验通过才写；已存在则先备份。 */
export function installSkill(wsRoot, { name, content, backupRoot = "", at = new Date().toISOString() } = {}) {
  if (!String(name || "").trim()) return { ok: false, errors: ["缺技能名"] };
  const v = validateSkillMd(content);
  if (!v.ok) return { ok: false, errors: v.errors };

  const dir = skillDir(wsRoot, name);
  const file = path.join(dir, "SKILL.md");
  let backup = "";
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && backupRoot) {
      const bdir = path.join(String(backupRoot), `skill-${Date.now().toString(36)}`);
      fs.mkdirSync(bdir, { recursive: true });
      backup = path.join(bdir, "SKILL.md");
      fs.copyFileSync(file, backup);
    }
    fs.writeFileSync(file, String(content), "utf8");
    fs.writeFileSync(path.join(dir, ".installed.json"), JSON.stringify({ name, at, backup }, null, 2), "utf8");
    return { ok: true, dir, file, backup };
  } catch (e) {
    return { ok: false, errors: [String(e?.message || e).slice(0, 160)] };
  }
}

export function listAuthoredSkills(wsRoot) {
  const root = path.join(String(wsRoot || "."), SKILLS_REL);
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const metaFile = path.join(root, d.name, ".installed.json");
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) } catch {}
      return { name: d.name, installedAt: meta.at || null, hasBackup: !!meta.backup };
    });
  } catch { return [] }
}

/** 给她的写作要求（模型提示词用）。 */
export function buildAuthorPrompt({ goal = "" } = {}) {
  return [
    "你要写一份技能文件 SKILL.md，让未来的自己按它做事。",
    `目标：${goal}`,
    "格式必须是：",
    "# <技能名>",
    "## 何时用",
    "（什么情况下该用它，越具体越好）",
    "## 怎么做",
    "（1. 2. 3. 可执行步骤，含要调用的工具）",
    "## 边界",
    "（什么时候不该用、失败怎么办）",
    "要求：不少于 200 字；不要 TODO/占位；不要泛泛而谈。",
  ].join("\n");
}
