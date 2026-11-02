// 看门狗判偏：空转/连续失败/只改不验（2026-11-02）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectDrift, recordDriftCheck, recentDrift } from "../../engine/watchdog-drift.mjs";

const now = Date.parse("2026-11-02T22:00:00");
const row = (tool, o = {}) => ({ tool, at: now - 60_000, argsHash: "h1", ok: true, ...o });

test("正常：少量调用不算偏", () => {
  const r = detectDrift([row("read"), row("write")], { now });
  assert.equal(r.drift, false);
  assert.equal(r.issues.length, 0);
});

test("空转：同工具同参数 5 次", () => {
  const rows = Array.from({ length: 5 }, () => row("bash"));
  const r = detectDrift(rows, { now });
  assert.equal(r.drift, true);
  assert.ok(r.issues.some((i) => i.code === "loop"));
});

test("连续失败：同一工具失败 3 次", () => {
  const rows = [row("bash", { ok: false }), row("bash", { ok: false }), row("bash", { ok: false })];
  const r = detectDrift(rows, { now });
  assert.ok(r.issues.some((i) => i.code === "failing"));
});

test("只改不验：写 6 次没过交付门", () => {
  const rows = Array.from({ length: 6 }, (_, i) => row("write", { argsHash: `w${i}` }));
  const r = detectDrift(rows, { now });
  assert.ok(r.issues.some((i) => i.code === "no_gate"));
});

test("窗口外的事件不参与", () => {
  const old = Array.from({ length: 6 }, () => row("bash", { at: now - 3 * 3600_000 }));
  const r = detectDrift(old, { now });
  assert.equal(r.drift, false);
});

test("台账：写入后能读回", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
  const res = detectDrift([row("bash", { ok: false }), row("bash", { ok: false }), row("bash", { ok: false })], { now });
  recordDriftCheck(root, res, { now });
  const list = recentDrift(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].drift, true);
});
