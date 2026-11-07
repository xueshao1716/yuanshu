import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = () => import("../../engine/drift-escalation.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ys-drift-"));

const LOOP = { code: "loop", detail: "write 同参数重复 6 次" };
const FAIL = { code: "failing", detail: "bash 连续失败 4 次" };

test("没有偏离就不惊动人", async () => {
  const { shouldEscalate } = await mod();
  assert.equal(shouldEscalate({ drift: false, issues: [] }).escalate, false);
  assert.equal(shouldEscalate({ drift: true, issues: [] }).escalate, false);
});

test("签名按 issue.code 归并：同类只算一个键，顺序无关", async () => {
  const { signatureOf } = await mod();
  assert.equal(signatureOf([LOOP]), "loop");
  assert.equal(signatureOf([LOOP, FAIL]), "failing+loop");
  assert.equal(signatureOf([FAIL, LOOP]), "failing+loop");
  assert.equal(signatureOf([]), "drift");
});

test("首次出现 → 报；冷却窗口内同类 → 不报；超窗 → 再报", async () => {
  const { shouldEscalate } = await mod();
  const now = 1_700_000_000_000;
  const first = shouldEscalate({ drift: true, issues: [LOOP], now, last: {} });
  assert.equal(first.escalate, true);

  const soon = shouldEscalate({ drift: true, issues: [LOOP], now: now + 60_000, last: { loop: now } });
  assert.equal(soon.escalate, false);
  assert.match(soon.reason, /刚报过/);

  const later = shouldEscalate({ drift: true, issues: [LOOP], now: now + 5 * 3600_000, last: { loop: now } });
  assert.equal(later.escalate, true);
});

test("不同类的新问题不被旧问题的冷却挡住", async () => {
  const { shouldEscalate } = await mod();
  const now = 1_700_000_000_000;
  const r = shouldEscalate({ drift: true, issues: [FAIL], now, last: { loop: now } });
  assert.equal(r.escalate, true);
  assert.equal(r.key, "failing");
});

test("通知正文：短、带细节、给两个明确出口", async () => {
  const { composeDriftNotice } = await mod();
  const text = composeDriftNotice([LOOP, FAIL], { limit: 1 });
  assert.match(text, /跑偏/);
  assert.match(text, /同参数重复/);
  assert.doesNotMatch(text, /连续失败/); // limit 生效
  assert.match(text, /继续/);
  assert.match(text, /停/);
});

test("通知时间表：写入后能读回，最多留 50 个签名", async () => {
  const { recordNotified, readLastNotified } = await mod();
  const ws = tmp();
  assert.deepEqual(readLastNotified(ws), {});
  recordNotified(ws, "loop", { now: 1000 });
  assert.equal(readLastNotified(ws).loop, 1000);
  for (let i = 0; i < 60; i += 1) recordNotified(ws, `k${i}`, { now: 2000 + i });
  assert.equal(Object.keys(readLastNotified(ws)).length, 50);
});
