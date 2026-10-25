// 工单号：每份反馈都能对上号（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installIdentity, newTicket, withTicket, ticketLine } from "../../engine/feedback-ticket.mjs";

function tmpWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-"));
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  return root;
}

test("installId 稳定不变（同机多份报告归到一起）", () => {
  const ws = tmpWs();
  const a = installIdentity(ws);
  const b = installIdentity(ws);
  assert.equal(a.installId, b.installId);
  assert.match(a.installId, /^[0-9a-f-]{36}$/);
});

test("工单号递增、带日期、可读", () => {
  const ws = tmpWs();
  const now = Date.parse("2026-10-26T00:30:00+08:00");
  const t1 = newTicket(ws, { now });
  const t2 = newTicket(ws, { now });
  assert.equal(t1.ticketId, "T-20261026-0001");
  assert.equal(t2.ticketId, "T-20261026-0002");
  assert.equal(t1.installId, t2.installId);
});

test("并进提交体时保留调用方已有的值", () => {
  const out = withTicket({ type: "bug", ticketId: "T-own-1" }, { ticketId: "T-20261026-0001", installId: "abc" });
  assert.equal(out.ticketId, "T-own-1", "不覆盖调用方给的");
  assert.equal(out.installId, "abc");
});

test("回信末尾那行：带工单号与设备号", () => {
  const line = ticketLine({ ticketId: "T-20261026-0001", installId: "f7be534c-1111-2222" });
  assert.match(line, /T-20261026-0001/);
  assert.match(line, /f7be534c/);
  assert.match(line, /回信时带上/);
  assert.equal(ticketLine({}), "");
});
