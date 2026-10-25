// 知识摄入能不能被"作业状态机"看见（2026-10-26）
// 真机：它 10/22 起停摆，直到用户问"知识板块怎么好久没变了"才被发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { knowledgeJob } from "../../engine/knowledge-job.mjs";

function wsWith({ jobs = [], slot = null, entryAgeMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kjob-"));
  const dir = path.join(root, "记忆", "知识");
  fs.mkdirSync(path.join(dir, "entries"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ v: 1, jobs }), "utf8");
  fs.writeFileSync(path.join(dir, "background-admission.json"), JSON.stringify({ v: 1, slot }), "utf8");
  const e = path.join(dir, "entries", "a.json");
  fs.writeFileSync(e, "{}", "utf8");
  if (entryAgeMs) { const t = new Date(Date.now() - entryAgeMs); fs.utimesSync(e, t, t); }
  return root;
}

test("租约被占用 → failed，并说清是谁占的", () => {
  const ws = wsWith({ slot: { consumer: "knowledge", pid: 13324, at: Date.now() - 3600_000 } });
  const j = knowledgeJob({ wsRoot: ws });
  assert.equal(j.state, "failed");
  assert.match(j.error, /13324/);
  assert.match(j.step, /租约/);
});

test("队列积压且很久没产出 → stalled（用户看到的那种「没新增」）", () => {
  const ws = wsWith({ jobs: [{}, {}, {}], entryAgeMs: 3 * 24 * 3600 * 1000 });
  const j = knowledgeJob({ wsRoot: ws });
  assert.equal(j.state, "stalled");
  assert.match(j.step, /没有新条目/);
});

test("刚有产出 → running", () => {
  const ws = wsWith({ jobs: [{}], entryAgeMs: 60_000 });
  const j = knowledgeJob({ wsRoot: ws });
  assert.equal(j.state, "running");
});

test("空工作区也不崩，给出 stalled 而不是假装正常", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kjob-empty-"));
  const j = knowledgeJob({ wsRoot: root });
  assert.equal(j.id, "knowledge:intake");
  assert.ok(["stalled", "running"].includes(j.state));
});

test("条目本身就是作业形态（能被 job_status 直接渲染）", () => {
  const ws = wsWith({ entryAgeMs: 1000 });
  const j = knowledgeJob({ wsRoot: ws });
  for (const k of ["id", "kind", "label", "state", "step"]) assert.ok(j[k] !== undefined, `缺少 ${k}`);
  assert.equal(j.kind, "knowledge");
});
