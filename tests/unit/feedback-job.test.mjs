// 收件箱进 job_status：谁报回来了、有没有人理（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { feedbackJob } from "../../engine/feedback-job.mjs";

function wsWith(items) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fbjob-"));
  fs.mkdirSync(path.join(root, "feedback"), { recursive: true });
  fs.writeFileSync(path.join(root, "feedback", "inbox.json"), JSON.stringify({ items }), "utf8");
  return root;
}

const H = 3600 * 1000;

test("有人报回来且一直没回信、超过 48h → stalled", () => {
  const now = Date.now();
  const ws = wsWith([{ id: "a", at: now - 72 * H, status: "open", title: "crash", replies: [] }]);
  const j = feedbackJob({ wsRoot: ws, now });
  assert.equal(j.state, "stalled");
  assert.match(j.step, /没回信/);
  assert.match(j.error, /48/);
});

test("刚报回来还没回信 → running（给点时间，别一进来就报警）", () => {
  const now = Date.now();
  const ws = wsWith([{ id: "a", at: now - 2 * H, status: "open", title: "crash", replies: [] }]);
  assert.equal(feedbackJob({ wsRoot: ws, now }).state, "running");
});

test("都回过信但还没定论 → running", () => {
  const now = Date.now();
  const ws = wsWith([{ id: "a", at: now - 100 * H, status: "open", title: "x", replies: [{ at: now - 90 * H, kind: "triage" }] }]);
  assert.equal(feedbackJob({ wsRoot: ws, now }).state, "running");
});

test("全处理完 → done", () => {
  const now = Date.now();
  const ws = wsWith([{ id: "a", at: now - 100 * H, status: "done", title: "x", replies: [{ at: 1, kind: "resolved" }] }]);
  assert.equal(feedbackJob({ wsRoot: ws, now }).state, "done");
});

test("空收件箱也不崩", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fbjob-empty-"));
  const j = feedbackJob({ wsRoot: root });
  assert.equal(j.state, "done");
  assert.match(j.step, /空/);
  assert.equal(j.kind, "feedback");
});
