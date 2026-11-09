// assembly 分级契约（2026-11-10）
//
// 全部用临时目录造假能力：判据只看盘上的文件与文本，不依赖元枢自己接没接——
// 否则这些测试会跟着仓库一起漂（改一个真实调用点就红一片）。
//
// 注意一处与需求字面不同的地方：判据写的是"implemented 需要导出 + 测试文件存在"，
// 所以**缺测试是停在 defined**，不是停在 implemented。测试按判据写，不按字面。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gradeCapability, levelBar, summarize, exitCodeFor } from "../../engine/assembly.mjs";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "assembly-test-"));
}

function put(root, rel, text = "") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function drop(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

/** 一份最小可判的假能力：模块 + 导出 + 测试 + 真调用点 + 路由开关。 */
function fakeRepo({ testFile = true, caller = "" } = {}) {
  const root = tempRepo();
  put(root, "engine/fake.mjs", "export const NAME = \"fake\";\nexport function doThing() { return 1; }\n");
  put(root, "engine/caller.mjs", caller || "import { doThing } from \"./fake.mjs\";\nexport const value = doThing();\n");
  put(root, "server.mjs", "const routes = [[\"GET\", \"/api/fake\", () => \"ok\"]];\n");
  if (testFile) put(root, "tests/unit/fake.test.mjs", "// 占位：只判存在\n");
  return root;
}

function spec(over = {}) {
  return {
    id: "fake",
    name: "假能力",
    files: ["engine/fake.mjs"],
    exports: ["doThing"],
    tests: ["tests/unit/fake.test.mjs"],
    callSites: ["engine/caller.mjs"],
    switches: [{ kind: "route", path: "/api/fake" }],
    ...over,
  };
}

test("四级逐级递进：文件、导出、测试、真调用、开关都在 → controllable", async () => {
  const root = fakeRepo();
  try {
    const g = await gradeCapability(spec(), { repoRoot: root });
    assert.equal(g.level, "controllable");
    assert.deepEqual(g.gaps, []);
    const ev = g.evidence.join("\n");
    assert.match(ev, /文件存在：engine\/fake\.mjs/);
    assert.match(ev, /导出可 import：doThing/);
    assert.match(ev, /测试存在：tests\/unit\/fake\.test\.mjs/);
    assert.match(ev, /调用点：engine\/caller\.mjs:2 doThing/);
    assert.match(ev, /开关：API 路由 \/api\/fake（server\.mjs:1）/);
    assert.equal(levelBar(g.level), "✓✓✓✓");
  } finally { drop(root); }
});

test("缺测试：停在 defined（implemented 的判据要求测试文件存在）", async () => {
  const root = fakeRepo({ testFile: false });
  try {
    const g = await gradeCapability(spec(), { repoRoot: root });
    assert.equal(g.level, "defined");
    assert.deepEqual(g.gaps, ["测试文件不存在：tests/unit/fake.test.mjs"]);
    assert.equal(levelBar(g.level), "✓✗··");
  } finally { drop(root); }
});

test("无调用点：停在 implemented，退出码 2（这是最该修的假活）", async () => {
  const root = fakeRepo({ caller: "import { doThing } from \"./fake.mjs\";\nexport const value = 1;\n" });
  try {
    const g = await gradeCapability(spec(), { repoRoot: root });
    assert.equal(g.level, "implemented", "只 import 没调用，不算接上");
    assert.deepEqual(g.gaps, ["implemented 但无调用点（doThing）"]);
    assert.equal(levelBar(g.level), "✓✓✗·");
    assert.equal(exitCodeFor([g]), 2);
    assert.match(summarize([g]).line, /1 项：1 implemented/);
  } finally { drop(root); }
});

test("注释与字符串里的符号不算调用点", async () => {
  const root = fakeRepo({
    caller: [
      "// doThing() 以后再说",
      "/* 这里也写着 doThing() */",
      "export const note = \"doThing()\";",
      "export const value = 1;",
      "",
    ].join("\n"),
  });
  try {
    const g = await gradeCapability(spec(), { repoRoot: root });
    assert.equal(g.level, "implemented");
    assert.match(g.gaps.join(""), /implemented 但无调用点/);
  } finally { drop(root); }
});

test("import 行与多行 import 续行不算调用；别名调用算", async () => {
  const root = fakeRepo({
    caller: ["import {", "  doThing,", "} from \"./fake.mjs\";", "export const value = 1;", ""].join("\n"),
  });
  try {
    const multi = await gradeCapability(spec(), { repoRoot: root });
    assert.equal(multi.level, "implemented", "多行 import 的续行不能当成调用");

    put(root, "engine/caller.mjs",
      "import { doThing as runThing } from \"./fake.mjs\";\nexport const value = runThing();\n");
    const aliased = await gradeCapability(spec({ switches: [] }), { repoRoot: root });
    assert.equal(aliased.level, "integrated", "别名调用是真调用");
    const ev = aliased.evidence.join("\n");
    assert.match(ev, /runThing（doThing）/);
  } finally { drop(root); }
});

test("缺开关：停在 integrated；声明了但找不到的开关同样不成立", async () => {
  const root = fakeRepo();
  try {
    const none = await gradeCapability(spec({ switches: [] }), { repoRoot: root });
    assert.equal(none.level, "integrated");
    assert.deepEqual(none.gaps, ["无开关/闸/可查状态"]);

    const bogus = await gradeCapability(spec({ switches: [{ kind: "route", path: "/api/nope" }] }), { repoRoot: root });
    assert.equal(bogus.level, "integrated");
    assert.deepEqual(bogus.gaps, ["开关都不成立：API 路由 /api/nope 在源码/配置里没找到"]);
  } finally { drop(root); }
});

test("声明文件不存在：停在 missing，gaps 指向缺的路径", async () => {
  const root = tempRepo();
  put(root, "server.mjs", "");
  try {
    const g = await gradeCapability(spec(), { repoRoot: root });
    assert.equal(g.level, "missing");
    assert.deepEqual(g.gaps, ["声明文件都不存在：engine/fake.mjs"]);
    assert.equal(levelBar(g.level), "✗···");
  } finally { drop(root); }
});

test("wired 自定义断言：过了算 integrated，没过照旧往下走 grep", async () => {
  const root = fakeRepo({ caller: "export const value = 1;\n" }); // 盘上没有任何调用
  try {
    const ok = await gradeCapability(spec({ switches: [], wired: () => ({ ok: true, evidence: "手工断言：已接线" }) }), { repoRoot: root });
    assert.equal(ok.level, "integrated");
    assert.match(ok.evidence.join("\n"), /接线断言：手工断言：已接线/);

    const bad = await gradeCapability(spec({ callSites: [], switches: [], wired: () => false }), { repoRoot: root });
    assert.equal(bad.level, "implemented");
    assert.equal(bad.gaps[0], "接线断言未通过");
    assert.match(bad.gaps.join(""), /没有声明调用点/);
  } finally { drop(root); }
});
