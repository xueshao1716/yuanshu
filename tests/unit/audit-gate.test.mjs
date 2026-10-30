// 动作审计：先记账再执行（对应 OpenBot 的"记录是行动的前置条件"）（2026-10-30）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuditGate, withAuditGate, summarizeArgs, auditPath } from "../../engine/tools/audit-gate.mjs";
import { runWithInitiator, DEFAULT_RULES } from "../../engine/tools/initiator.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));

test("执行前先写一行，执行后补一行", async () => {
  const root = ws();
  const gate = createAuditGate({ wsRoot: root });
  const exec = withAuditGate(async () => ({ text: "ok" }), { gate });
  const r = await exec("bash", { command: "echo hi" }, { sessionId: "s1" });
  assert.equal(r.text, "ok");
  const rows = gate.tail(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].phase, "before");
  assert.equal(rows[0].tool, "bash");
  assert.equal(rows[0].session, "s1");
  assert.equal(rows[1].phase, "after");
  assert.equal(rows[1].ok, true);
});

test("失败也会留痕（ok:false + error）", async () => {
  const root = ws();
  const gate = createAuditGate({ wsRoot: root });
  const exec = withAuditGate(async () => ({ text: "炸了", isError: true }), { gate });
  await exec("write", { path: "a" }, {});
  const rows = gate.tail(5);
  assert.equal(rows.at(-1).ok, false);
  assert.match(rows.at(-1).error, /炸了/);
});

test("抛异常也留痕，并把异常继续抛出", async () => {
  const root = ws();
  const gate = createAuditGate({ wsRoot: root });
  const exec = withAuditGate(async () => { throw new Error("boom") }, { gate });
  await assert.rejects(() => exec("bash", {}, {}), /boom/);
  const rows = gate.tail(5);
  assert.equal(rows.at(-1).phase, "after");
  assert.equal(rows.at(-1).ok, false);
});

test("审计写不进去 → 拒绝执行（fail-closed）", async () => {
  const root = ws();
  // 用一个目录当文件路径，appendFileSync 必失败
  const blocked = path.join(root, "as-dir");
  fs.mkdirSync(blocked, { recursive: true });
  const gate = createAuditGate({ wsRoot: root, file: path.join(blocked, "x.jsonl") });
  fs.mkdirSync(path.join(blocked, "x.jsonl"));
  let ran = false;
  const exec = withAuditGate(async () => { ran = true; return { text: "ok" } }, { gate });
  const r = await exec("bash", {}, {});
  assert.equal(r.isError, true);
  assert.match(r.text, /审计写不进去/);
  assert.equal(ran, false, "没记账就不许执行");
});

test("YUANSHU_AUDIT_SOFT=1 时放行但标记 softSkipped", async () => {
  const root = ws();
  const blocked = path.join(root, "b");
  fs.mkdirSync(path.join(blocked, "x.jsonl"), { recursive: true });
  const gate = createAuditGate({ wsRoot: root, file: path.join(blocked, "x.jsonl"), soft: true });
  const r = gate.before({ tool: "bash", args: {} });
  assert.equal(r.ok, true);
  assert.equal(r.softSkipped, true);
});

test("参数只留 hash 和脱敏预览（令牌不进审计）", () => {
  const s = summarizeArgs({ command: "curl -H 'Authorization: Bearer abc'", token: "sk-live-1234567890abcdefghijklmn" });
  assert.equal(s.hash.length, 16);
  assert.ok(!s.preview.includes("sk-live-1234567890abcdefghijklmn"));
  assert.ok(s.bytes > 0);
});

test("默认写到 记忆/运行时/动作审计.jsonl", () => {
  const root = ws();
  assert.match(auditPath(root), /动作审计\.jsonl$/);
  const gate = createAuditGate({ wsRoot: root });
  gate.before({ tool: "read", args: { path: "a.md" } });
  assert.ok(fs.existsSync(auditPath(root)));
});

test('定时任务上下文里，审计行带 initiator=scheduler', async () => {
  const root = ws();
  const gate = createAuditGate({ wsRoot: root });
  const exec = withAuditGate(async () => ({ text: 'ok' }), { gate, rules: DEFAULT_RULES });
  await runWithInitiator('scheduler', () => exec('read', { path: 'a.md' }, {}));
  const rows = gate.tail(5);
  assert.equal(rows[0].initiator, 'scheduler');
});

test('定时任务调 notify_user 被拒：返回错误 + 留 denied 行', async () => {
  const root = ws();
  const gate = createAuditGate({ wsRoot: root });
  let ran = false;
  const exec = withAuditGate(async () => { ran = true; return { text: 'ok' } }, { gate, rules: DEFAULT_RULES });
  const r = await runWithInitiator('scheduler', () => exec('notify_user', { text: 'hi' }, {}));
  assert.equal(r.isError, true);
  assert.equal(r.denied, true);
  assert.equal(ran, false, '被拒就不该执行');
  const rows = gate.tail(5);
  assert.equal(rows.at(-1).phase, 'denied');
  assert.equal(rows.at(-1).ruleId, 'no-scheduler-external');
});

test('同一个动作，人让做的就放行（对照）', async () => {
  const root = ws();
  const gate = createAuditGate({ wsRoot: root });
  const exec = withAuditGate(async () => ({ text: 'ok' }), { gate, rules: DEFAULT_RULES });
  const r = await exec('notify_user', { text: 'hi' }, {});
  assert.equal(r.text, 'ok');
  assert.equal(gate.tail(5)[0].initiator, 'user');
});
