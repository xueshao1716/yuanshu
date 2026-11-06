// 失败台账：记录/召回/按文件命中（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordFailure, recallFailures, failureLine, recentFailures, recordPatchFailure, readFailures,
} from "../../engine/failure-ledger.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "fail-"));

test("记录：字段齐全，落盘", () => {
  const root = ws();
  const r = recordFailure({ wsRoot: root, agent: "小语", area: "微信发图", attempt: "用 sendImage 直接发", why: "CDN 500", files: ["engine/wechat/ilink.mjs"], source: "patch" });
  assert.equal(r.ok, true);
  assert.match(r.entry.id, /^f-/);
  assert.equal(recentFailures(root).length, 1);
  assert.ok(fs.existsSync(path.join(root, "记忆", "运行时", "失败台账.json")));
});

test("空 attempt 与空 why 一起时拒绝", () => {
  const root = ws();
  assert.equal(recordFailure({ wsRoot: root, attempt: "", why: "" }).ok, false);
  assert.equal(readFailures(root).items.length, 0);
});

test("召回：文件命中权重最高", () => {
  const root = ws();
  recordFailure({ wsRoot: root, area: "改 doc-diff", attempt: "直接扫全盘", why: "20 万文件吃满上限", files: ["engine/doc-diff.mjs"] });
  recordFailure({ wsRoot: root, area: "改微信", attempt: "voice_item", why: "ret=-2", files: ["engine/wechat/ilink.mjs"] });

  const byFile = recallFailures({ wsRoot: root, files: ["engine/doc-diff.mjs"] });
  assert.equal(byFile[0].entry.area, "改 doc-diff");
  assert.ok(byFile[0].hitFiles.includes("engine/doc-diff.mjs"));
});

test("召回：反斜杠路径也能对上", () => {
  const root = ws();
  recordFailure({ wsRoot: root, area: "a", attempt: "x", why: "y", files: ["engine/doc-diff.mjs"] });
  const hit = recallFailures({ wsRoot: root, files: ["D:\\pi-web\\engine\\doc-diff.mjs"] });
  assert.equal(hit.length, 1);
});

test("召回：没关键词不硬凑", () => {
  const root = ws();
  recordFailure({ wsRoot: root, area: "微信", attempt: "voice", why: "不支持" });
  assert.equal(recallFailures({ wsRoot: root, text: "完全无关的数据库迁移" }).length, 0);
  assert.equal(failureLine({ wsRoot: root, text: "完全无关" }), "");
});

test("环境事实一行：有相似失败才出现", () => {
  const root = ws();
  recordFailure({ wsRoot: root, area: "补丁：渲染重试", attempt: "自动补丁", why: "门禁未过：3 条红灯", files: ["engine/job-state.mjs"] });
  const line = failureLine({ wsRoot: root, files: ["engine/job-state.mjs"] });
  assert.match(line, /【踩过的坑】/);
  assert.match(line, /门禁未过/);
});

test("补丁失败包装：gate 记 gate 来源，其他记 patch", () => {
  const root = ws();
  recordPatchFailure({ wsRoot: root, proposal: { title: "修 X" }, stage: "gate", error: "红灯", files: ["a.mjs"] });
  recordPatchFailure({ wsRoot: root, proposal: { title: "修 Y" }, stage: "apply", error: "写入失败", files: ["b.mjs"] });
  const items = recentFailures(root);
  assert.equal(items.find((i) => i.area.includes("修 X")).source, "gate");
  assert.equal(items.find((i) => i.area.includes("修 Y")).source, "patch");
});
