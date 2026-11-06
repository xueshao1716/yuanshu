// impossible 语义：阈值 / 判定 / 开工前拦截（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordFailure, countSimilar, markImpossible, isImpossible, evaluateImpossible, IMPOSSIBLE_THRESHOLD } from "../../engine/failure-ledger.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "imp-"));

test("不到阈值：只报还差几次", () => {
  const root = ws();
  recordFailure({ wsRoot: root, area: "补丁：语音条", attempt: "a", why: "ret=-2" });
  recordFailure({ wsRoot: root, area: "补丁：语音条", attempt: "b", why: "ret=-2" });
  const r = evaluateImpossible({ wsRoot: root, area: "补丁：语音条" });
  assert.equal(r.impossible, false);
  assert.equal(r.times, 2);
  assert.equal(r.left, IMPOSSIBLE_THRESHOLD - 2);
});

test("到阈值：自动落一条 impossible，之后开工前能查到", () => {
  const root = ws();
  for (let i = 0; i < IMPOSSIBLE_THRESHOLD; i += 1) {
    recordFailure({ wsRoot: root, area: "补丁：语音条", attempt: "voice_item", why: "ret=-2 prepare failed" });
  }
  const r = evaluateImpossible({ wsRoot: root, area: "补丁：语音条" });
  assert.equal(r.impossible, true);
  const check = isImpossible({ wsRoot: root, area: "补丁：语音条" });
  assert.equal(check.impossible, true);
  assert.match(check.why, /累计失败/);
});

test("按文件命中也能判定（换了标题但动同一份文件）", () => {
  const root = ws();
  for (let i = 0; i < IMPOSSIBLE_THRESHOLD; i += 1) {
    recordFailure({ wsRoot: root, area: `补丁：第${i}版`, attempt: "x", why: "门禁未过", files: ["engine/wechat/ilink.mjs"] });
  }
  assert.equal(isImpossible({ wsRoot: root, area: "补丁：全新标题", files: ["engine/wechat/ilink.mjs"] }).impossible, true);
});

test("无关的事不会被误判 impossible", () => {
  const root = ws();
  for (let i = 0; i < IMPOSSIBLE_THRESHOLD; i += 1) {
    recordFailure({ wsRoot: root, area: "补丁：语音条", attempt: "x", why: "y", files: ["engine/wechat/ilink.mjs"] });
  }
  assert.equal(isImpossible({ wsRoot: root, area: "补丁：数据库迁移", files: ["engine/db.mjs"] }).impossible, false);
});

test("impossible 记录本身不再计入失败次数（否则会自我繁殖）", () => {
  const root = ws();
  for (let i = 0; i < IMPOSSIBLE_THRESHOLD; i += 1) {
    recordFailure({ wsRoot: root, area: "补丁：X", attempt: "x", why: "y" });
  }
  markImpossible({ wsRoot: root, area: "补丁：X", why: "人工判定" });
  const c = countSimilar({ wsRoot: root, area: "补丁：X" });
  assert.equal(c.times, IMPOSSIBLE_THRESHOLD, "判定记录不该再加一次");
});
