// 认领板：单任务互斥 / 范围冲突 / TTL 过期 / 释放（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimTask, releaseClaim, renewClaim, activeClaims, listClaims, reapExpired,
  scopesOverlap, claimsLine, DEFAULT_TTL_MS,
} from "../../engine/claim-board.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "claim-"));

test("scopesOverlap：相同/包含/目录前缀算重叠，无关不算", () => {
  assert.equal(scopesOverlap(["engine/a.mjs"], ["engine/a.mjs"]), true);
  assert.equal(scopesOverlap(["engine"], ["engine/a.mjs"]), true, "目录包含文件");
  assert.equal(scopesOverlap(["D:\\pi-web\\engine\\a.mjs"], ["engine/a.mjs"]), true, "反斜杠要归一");
  assert.equal(scopesOverlap(["engine/a.mjs"], ["engine/b.mjs"]), false);
  assert.equal(scopesOverlap([], ["engine"]), false);
});

test("同一任务只能一个人认领；同一人重复认领返回 already", () => {
  const root = ws();
  const a = claimTask({ wsRoot: root, task: "修微信发图", agent: "小语" });
  assert.equal(a.ok, true);

  const b = claimTask({ wsRoot: root, task: "修微信发图", agent: "另一个" });
  assert.equal(b.ok, false);
  assert.match(b.error, /已被 小语 认领/);

  const again = claimTask({ wsRoot: root, task: "修微信发图", agent: "小语" });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
});

test("范围重叠拒绝认领，并列出冲突方", () => {
  const root = ws();
  claimTask({ wsRoot: root, task: "改 detached", agent: "甲", scope: ["engine/detached-run.mjs"] });
  const r = claimTask({ wsRoot: root, task: "改 doc-diff", agent: "乙", scope: ["engine"] });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].agent, "甲");
});

test("TTL 到期后可被回收并重新认领", () => {
  const root = ws();
  const t0 = Date.now();
  const a = claimTask({ wsRoot: root, task: "任务A", agent: "甲", scope: ["a/"], now: t0, ttlMs: 1000 });
  assert.equal(a.ok, true);

  // 未过期：别人不能抢
  const blocked = claimTask({ wsRoot: root, task: "任务A", agent: "乙", now: t0 + 500 });
  assert.equal(blocked.ok, false);

  // 过期后：reap 标 expired，可以重新认领
  const reaped = reapExpired({ wsRoot: root, now: t0 + 2000 });
  assert.equal(reaped.reaped, 1);
  const taken = claimTask({ wsRoot: root, task: "任务A", agent: "乙", now: t0 + 3000 });
  assert.equal(taken.ok, true);
});

test("释放：done 记完成，abandoned 记放弃；释放后可被他人认领", () => {
  const root = ws();
  const a = claimTask({ wsRoot: root, task: "任务B", agent: "甲", scope: ["b/"] });
  const rel = releaseClaim({ wsRoot: root, id: a.claim.id, done: false, note: "换人" });
  assert.equal(rel.ok, true);
  assert.equal(rel.claim.state, "abandoned");
  assert.equal(rel.claim.note, "换人");

  const b = claimTask({ wsRoot: root, task: "任务B", agent: "乙", scope: ["b/"] });
  assert.equal(b.ok, true);
});

test("续期把 expiresAt 往后推", () => {
  const root = ws();
  const t0 = Date.now();
  const a = claimTask({ wsRoot: root, task: "任务C", agent: "甲", now: t0, ttlMs: 1000 });
  const r = renewClaim({ wsRoot: root, id: a.claim.id, now: t0 + 900, ttlMs: DEFAULT_TTL_MS });
  assert.equal(r.ok, true);
  assert.ok(r.claim.expiresAt > t0 + 1000);
});

test("列表中过期标记 + 环境事实一行", () => {
  const root = ws();
  const t0 = Date.now();
  claimTask({ wsRoot: root, task: "任务D", agent: "甲", now: t0, ttlMs: 1000 });
  const active = activeClaims(root, { now: t0 + 2000 });
  assert.equal(active[0].expired, true);
  assert.match(claimsLine(root, { now: t0 + 100 }), /【认领】/, "有效期内要有一行");
  assert.equal(claimsLine(root, { now: t0 + 2000 }), "", "过期之后不该再报");
});
