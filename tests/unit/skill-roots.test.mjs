// 技能多根解析：原来只有一个根（运行实例的 skills/），装一条技能要么写仓库（运行版看不见）
// 要么写安装目录（要管理员），于是被误判成"沙箱权限不够"。这里钉住新规则。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initContextLoader, loadSkillIndex, execActivateSkill, findSkillDir,
  skillRoots, workspaceSkillRoots, REPO_SKILLS_DIR,
} from "../../engine/context-loader.mjs";
import { setSkillCache, resetSkillCache } from "../../engine/skill-cache.mjs";

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skillroots-"));
}

function addSkill(root, name, { body = "正文", desc = "说明" } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n${body}\n`, "utf8");
  return dir;
}

test("工作区内置两种技能目录都算；没有 SKILL.md 的目录不算技能", () => {
  const ws = tmpWs();
  addSkill(path.join(ws, "技能"), "alpha");
  addSkill(path.join(ws, "skills"), "beta");
  // 数据目录：长得像技能目录，但没有 SKILL.md（真实存在：工作区 skills/@user_xxx）
  fs.mkdirSync(path.join(ws, "skills", "@user_deadbeef"), { recursive: true });
  initContextLoader({ cwd: ws });

  const list = loadSkillIndex();
  const names = list.map((s) => s.name);
  assert.ok(names.includes("alpha"), "技能/ 下的要看见");
  assert.ok(names.includes("beta"), "skills/ 下的也要看见");
  assert.ok(!names.includes("@user_deadbeef"), "没有 SKILL.md 的数据目录不能当技能");
  assert.ok(skillRoots(ws).includes(REPO_SKILLS_DIR), "内置根仍然在（兜底）");
  assert.deepEqual(workspaceSkillRoots(ws).length, 2);
});

test("同名以 技能/ 优先：不动安装目录就能覆盖一条技能", () => {
  const ws = tmpWs();
  addSkill(path.join(ws, "技能"), "dup", { desc: "工作区版" });
  addSkill(path.join(ws, "skills"), "dup", { desc: "旧版" });
  initContextLoader({ cwd: ws });
  const list = loadSkillIndex();
  const hit = list.filter((s) => s.name === "dup");
  assert.equal(hit.length, 1, "同名只能出现一次，否则摘要列表会重复计条数");
  assert.match(hit[0].desc, /工作区版/);
  assert.equal(findSkillDir("dup", ws), path.join(ws, "技能", "dup"));
});

test("activate_skill 能加载工作区技能全文，并列资源清单", () => {
  const ws = tmpWs();
  const dir = addSkill(path.join(ws, "技能"), "huashu-design", { body: "三方向门 · 参考板 · 外观账本", desc: "设计" });
  fs.mkdirSync(path.join(dir, "references"));
  fs.mkdirSync(path.join(dir, "scripts"));
  initContextLoader({ cwd: ws });

  const out = execActivateSkill("huashu-design");
  assert.ok(!out.isError, `应能加载，实际：${out.text.slice(0, 120)}`);
  assert.match(out.text, /已加载/);
  assert.match(out.text, /三方向门/);
  assert.match(out.text, /references/);
  assert.match(out.text, /scripts/);
});

test("名字穿越与不存在的技能：报错但不崩", () => {
  const ws = tmpWs();
  addSkill(path.join(ws, "技能"), "real");
  initContextLoader({ cwd: ws });
  for (const bad of ["../../etc", "..\\..\\windows", "", "nope"]) {
    const out = execActivateSkill(bad);
    assert.equal(out.isError, true, `"${bad}" 必须被拒`);
  }
  assert.equal(findSkillDir("../../etc", ws), "", "穿越名不能解析出目录");
});

test("面板清单与 activate_skill 同源：线上/包内技能模型也能加载", () => {
  const ws = tmpWs();
  initContextLoader({ cwd: ws });
  const dir = path.join(ws, "线上技能", "online-x");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, "---\nname: online-x\ndescription: 线上装的\n---\n\n# online-x\n\n只有面板知道的内容\n", "utf8");

  // 模拟 stats-api.listSkills() 写缓存（实际它会扫 ~/.pi、~/.agents、node_modules）
  setSkillCache([{ name: "online-x", desc: "线上装的", path: file, source: "online" }]);
  try {
    assert.ok(loadSkillIndex().some((s) => s.name === "online-x"), "面板有的技能，模型索引里必须有");
    const out = execActivateSkill("online-x");
    assert.ok(!out.isError, "以前这里会回「技能不存在」，正是那句误判的源头");
    assert.match(out.text, /只有面板知道的内容/);
  } finally {
    resetSkillCache();
  }
  // 缓存清掉后回到目录扫描：这个技能不在工作区技能根里，所以找不到——行为可预期
  assert.equal(findSkillDir("online-x"), "", "缓存只影响索引与加载，不该把任意路径变成技能根");
});

test("新增技能后索引会刷新（多个根的 mtime 一起做缓存戳）", () => {
  const ws = tmpWs();
  addSkill(path.join(ws, "技能"), "first");
  initContextLoader({ cwd: ws });
  const before = loadSkillIndex();
  assert.ok(before.some((s) => s.name === "first"));
  // 内置的 46 条始终在，所以比的是增量而不是绝对值
  const base = before.length;
  addSkill(path.join(ws, "技能"), "second");
  const after = loadSkillIndex();
  assert.equal(after.length, base + 1, "新增技能后条数应 +1");
  assert.ok(after.some((s) => s.name === "second"), "新增技能没被索引到，缓存戳没算多个根");
});
