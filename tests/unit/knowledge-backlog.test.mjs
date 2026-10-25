// 积压出口：卡死的要能自己出队（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyJob, drainBacklog, STALE_MS } from "../../engine/knowledge-backlog.mjs";

const H = 3600 * 1000;
const now = Date.parse("2026-10-26T00:00:00Z");

test("环境性 blocked 且还不算老 → 重排一次", () => {
  const v = classifyJob({ state: "blocked", reason: "knowledge_budget_exhausted", createdAt: now - 2 * H }, { now });
  assert.equal(v.action, "requeue");
});

test("blocked 卡了一周以上 → 跳过（占着队列才是真损失）", () => {
  const v = classifyJob({ state: "blocked", reason: "source_unavailable", createdAt: now - 8 * 24 * H }, { now });
  assert.equal(v.action, "skip");
  assert.equal(v.reason, "blocked_stale");
});

test("非环境性 blocked 超时也跳过（不能永远挂着）", () => {
  const v = classifyJob({ state: "blocked", reason: "weird_unknown", createdAt: now - 9 * 24 * H }, { now });
  assert.equal(v.action, "skip");
});

test("待复核超过窗口 → 标过期，而不是挂半个月", () => {
  const v = classifyJob({ state: "review_required", createdAt: now - 10 * 24 * H }, { now });
  assert.equal(v.action, "skip");
  assert.equal(v.reason, "review_stale");
  const fresh = classifyJob({ state: "review_required", createdAt: now - 1 * H }, { now });
  assert.equal(fresh.action, "keep");
});

test("drainBacklog：默认只出计划，不动物；apply 才改，且留 reason", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  fs.mkdirSync(path.join(root, "记忆", "知识"), { recursive: true });
  const file = path.join(root, "记忆", "知识", "state.json");
  fs.writeFileSync(file, JSON.stringify({
    jobs: {
      a: { state: "blocked", reason: "knowledge_budget_exhausted", createdAt: now - 2 * H, revision: 1 },
      b: { state: "blocked", reason: "source_unavailable", createdAt: now - 10 * 24 * H, revision: 1 },
      c: { state: "committed", createdAt: now - 99 * 24 * H },
    },
  }), "utf8");

  const dry = drainBacklog({ wsRoot: root, now });
  assert.equal(dry.applied, false);
  assert.equal(dry.counts.requeue, 1);
  assert.equal(dry.counts.skip, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).jobs.b.state, "blocked", "dry run 不能改文件");

  const wet = drainBacklog({ wsRoot: root, now, apply: true });
  assert.equal(wet.applied, true);
  const after = JSON.parse(fs.readFileSync(file, "utf8")).jobs;
  assert.equal(after.a.state, "queued");
  assert.equal(after.a.attempts, 1);
  assert.equal(after.b.state, "skipped");
  assert.equal(after.b.reason, "blocked_stale");
  assert.equal(after.c.state, "committed", "已入库的不动");
});
