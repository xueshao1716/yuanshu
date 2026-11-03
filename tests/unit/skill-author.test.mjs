// 造技能：格式校验 + 安装 + 备份（2026-11-03）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateSkillMd, installSkill, listAuthoredSkills, buildAuthorPrompt, skillDir } from "../../engine/learning/skill-author.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "skill-"));
const good = [
  "# 网页转周报",
  "",
  "## 何时用",
  "用户给一个网页链接，说要整理成周报时用。",
  "",
  "## 怎么做",
  "1. 抓取网页正文。",
  "2. 按项目/成果/风险三段归类。",
  "3. 输出 markdown 到 生成物。",
  "",
  "## 边界",
  "页面要登录时不要硬抓；抓不到就如实说。",
  "",
  "补充说明：".padEnd(180, "写清楚失败时的降级路径，不要假装成功。"),
].join("\n");

test("合格：三段齐全、有标题、够长", () => {
  assert.equal(validateSkillMd(good).ok, true);
});

test("不合格：缺小节 / 太短 / 含占位符", () => {
  const r1 = validateSkillMd("# 只有标题\n\n## 何时用\n随便");
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes("太短")));
  assert.ok(r1.errors.some((e) => e.includes("边界")));
  const r2 = validateSkillMd(good.replace("## 边界", "## 边界\nTODO"));
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes("占位")));
});

test("安装：写到 工作区/技能/<名字>/SKILL.md", () => {
  const root = ws();
  const r = installSkill(root, { name: "web-to-weekly", content: good });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(skillDir(root, "web-to-weekly"), "SKILL.md")));
});

test("安装：不合格不落盘", () => {
  const root = ws();
  const r = installSkill(root, { name: "bad", content: "# x" });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(skillDir(root, "bad")), false);
});

test("覆盖安装：先备份旧文件", () => {
  const root = ws();
  const backupRoot = path.join(root, "备份");
  installSkill(root, { name: "web-to-weekly", content: good });
  const r2 = installSkill(root, { name: "web-to-weekly", content: good.replace("网页转周报", "网页转周报 v2"), backupRoot });
  assert.equal(r2.ok, true);
  assert.ok(r2.backup && fs.existsSync(r2.backup));
});

test("列表能看到已装技能", () => {
  const root = ws();
  installSkill(root, { name: "a-skill", content: good });
  const list = listAuthoredSkills(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "a-skill");
  assert.ok(list[0].installedAt);
});

test("提示词包含格式要求", () => {
  const p = buildAuthorPrompt({ goal: "把网页转周报" });
  assert.match(p, /何时用/);
  assert.match(p, /边界/);
});
