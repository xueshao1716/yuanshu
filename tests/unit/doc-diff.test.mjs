// 文档变化感知：基线不误报、改动能发现、能对上目标（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffDocs, scanDocs, relateToTargets, docChangesLine, readManifest, resetManifest } from "../../engine/doc-diff.mjs";

function ws() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docdiff-"));
  fs.mkdirSync(path.join(root, "文档"), { recursive: true });
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
  return root;
}

test("第一次扫描只建基线，不报变化（避免一启动就刷一堆）", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "文档", "需求.md"), "# 需求\nv1\n", "utf8");
  const r = diffDocs({ wsRoot: root });
  assert.equal(r.baseline, true);
  assert.equal(r.added.length, 0, "基线期不该报新增");
  assert.equal(r.created ?? 0, 0);
  assert.ok(r.total >= 1);
});

test("第二次扫描能发现修改与新增", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "文档", "需求.md"), "# 需求\nv1\n", "utf8");
  diffDocs({ wsRoot: root });                       // 建基线
  fs.writeFileSync(path.join(root, "文档", "需求.md"), "# 需求\nv2 加了权限要求\n", "utf8");
  fs.writeFileSync(path.join(root, "文档", "新方案.md"), "# 新方案\n", "utf8");

  const r = diffDocs({ wsRoot: root });
  assert.equal(r.baseline, false);
  assert.ok(r.modified.some((c) => c.path.endsWith("需求.md")), JSON.stringify(r.modified));
  assert.ok(r.added.some((c) => c.path.endsWith("新方案.md")), JSON.stringify(r.added));
});

test("删除也能发现；node_modules 与运行时噪音被跳过", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "文档", "gone.md"), "x", "utf8");
  fs.writeFileSync(path.join(root, "node_modules", "x", "readme.md"), "x", "utf8");
  fs.writeFileSync(path.join(root, "记忆", "运行时", "待汇报.json"), "{}", "utf8");
  diffDocs({ wsRoot: root });

  fs.rmSync(path.join(root, "文档", "gone.md"));
  const r = diffDocs({ wsRoot: root });
  assert.ok(r.deleted.some((c) => c.path.endsWith("gone.md")), JSON.stringify(r.deleted));

  const scanned = [...scanDocs({ wsRoot: root }).keys()];
  assert.ok(!scanned.some((p) => p.includes("node_modules")), "不该扫 node_modules");
  assert.ok(!scanned.some((p) => p.includes("记忆/运行时")), "不该扫运行时");
});

test("变化能和目标对上号（关键词重合）", () => {
  const hit = relateToTargets({ path: "文档/access-control.md" }, [
    { id: "g1", text: "重做资料库的 access control 权限模型" },
    { id: "g2", text: "写宣传片脚本" },
  ]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, "g1");
});

test("环境事实里那一行：有近期变化才出现，且带相关性", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "文档", "权限.md"), "v1", "utf8");
  diffDocs({ wsRoot: root });
  fs.writeFileSync(path.join(root, "文档", "权限.md"), "v2 改成团队共用", "utf8");
  diffDocs({ wsRoot: root, targets: [{ id: "g1", text: "资料库 权限 团队共用" }] });

  const line = docChangesLine({ wsRoot: root });
  assert.match(line, /【文档变化】/);
  assert.match(line, /权限\.md/);
});

test("resetManifest 能重建基线", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "文档", "a.md"), "1", "utf8");
  diffDocs({ wsRoot: root });
  resetManifest(root);
  const data = readManifest(root);
  assert.equal(data.baselineAt, 0);
  assert.deepEqual(data.changes, []);
});
