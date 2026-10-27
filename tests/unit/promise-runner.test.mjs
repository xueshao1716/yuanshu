// 承诺到点自动干活：到期筛选/执行/失败也报（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { duePromises, runDuePromises, markFired } from "../../engine/promise-runner.mjs";
import { loadPromises, promisePaths } from "../../engine/promises.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "promise-run-"));

function seed(wsRoot, items) {
  const { dir, file } = promisePaths(wsRoot);
  fs.mkdirSync(dir, { recursive: true });
  // 真实落盘形态是数组（loadPromises 按数组归一）
  fs.writeFileSync(file, JSON.stringify(items, null, 2), "utf8");
}

const P = (over = {}) => ({
  id: "p1", at: new Date().toISOString(), sessionId: "", text: "明天整理周报",
  due: new Date(Date.now() - 60_000).toISOString(), status: "pending", evidence: null, closedAt: null, ...over,
});

test("到期筛选：只取 pending + 已到期 + 没执行过", () => {
  const root = ws();
  seed(root, [
    P({ id: "due", due: new Date(Date.now() - 1000).toISOString() }),
    P({ id: "future", due: new Date(Date.now() + 3600_000).toISOString() }),
    P({ id: "done", due: new Date(Date.now() - 1000).toISOString(), status: "kept" }),
    P({ id: "fired", due: new Date(Date.now() - 1000).toISOString(), firedAt: new Date().toISOString() }),
    P({ id: "nodue", due: null }),
  ]);
  const due = duePromises({ wsRoot: root });
  assert.deepEqual(due.map((x) => x.id), ["due"]);
});

test("执行成功：调 run、发结果、标 kept、写 firedPhase=done", async () => {
  const root = ws();
  seed(root, [P()]);
  const sent = [];
  const out = await runDuePromises({
    wsRoot: root, limit: 5,
    run: async () => "周报写好了：本周完成 3 件事",
    send: async (m) => sent.push(m),
  });
  assert.equal(out.fired, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /到点了/);
  assert.match(sent[0].text, /本周完成 3 件事/);
  const item = loadPromises(root).find((x) => x.id === "p1");
  assert.equal(item.status, "kept");
  assert.equal(item.firedPhase, "done");
});

test("执行失败：也要推一条说明，状态记 missed", async () => {
  const root = ws();
  seed(root, [P()]);
  const sent = [];
  const out = await runDuePromises({
    wsRoot: root, run: async () => { throw new Error("模型超时") }, send: async (m) => sent.push(m),
  });
  assert.equal(out.failed, 1);
  assert.match(sent[0].text, /没做成/);
  assert.match(sent[0].text, /模型超时/);
  assert.equal(loadPromises(root).find((x) => x.id === "p1").status, "missed");
});

test("同一批最多跑 limit 条", async () => {
  const root = ws();
  seed(root, [P({ id: "a" }), P({ id: "b" }), P({ id: "c" })]);
  const out = await runDuePromises({ wsRoot: root, limit: 2, run: async () => "ok", send: async () => {} });
  assert.equal(out.fired, 2);
});

test("markFired 不会打乱状态机字段", () => {
  const root = ws();
  seed(root, [P()]);
  markFired(root, "p1", { phase: "started" });
  const it = loadPromises(root)[0];
  assert.ok(it.firedAt);
  assert.equal(it.status, "pending");
  assert.equal(it.firedPhase, "started");
});
