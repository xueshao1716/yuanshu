import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = () => import("../../engine/mandate.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ys-mandate-"));
const T0 = 1_700_000_000_000;

test("开授权：必须有 ticketId；同一张活重复开不会开第二张", async () => {
  const { createMandate, getMandate } = await mod();
  const ws = tmp();
  assert.equal(createMandate(ws, { scope: ["write"] }).ok, false);

  const a = createMandate(ws, { ticketId: "T-1", threadKey: "task:t1", scope: ["write", "shell"], basis: "explicit", now: T0 });
  assert.equal(a.ok, true);
  assert.equal(a.mandate.ticketId, "T-1");
  assert.deepEqual(a.mandate.scope, ["write", "shell"]);
  assert.equal(a.mandate.expiresAt, T0 + 24 * 3600_000);

  const again = createMandate(ws, { ticketId: "T-1", scope: ["publish"], now: T0 + 1 });
  assert.equal(again.mandate.scope.includes("publish"), false); // 复用了已有的那张
  assert.equal(getMandate(ws, "T-1").threadKey, "task:t1");
});

test("判定：范围内放行，范围外拒绝，越权动作永远要人", async () => {
  const { createMandate, checkMandate } = await mod();
  const ws = tmp();
  const { mandate } = createMandate(ws, { ticketId: "T-2", scope: ["write", "publish"], now: T0 });

  assert.equal(checkMandate(mandate, "write", { now: T0 + 1000 }).ok, true);
  assert.equal(checkMandate(mandate, "shell", { now: T0 + 1000 }).ok, false);
  assert.match(checkMandate(mandate, "shell", { now: T0 + 1000 }).reason, /范围里没有/);

  const pub = checkMandate(mandate, "publish", { now: T0 + 1000 });
  assert.equal(pub.ok, false); // 写在 scope 里也不行
  assert.match(pub.reason, /永远要人点头/);

  assert.equal(checkMandate(null, "write").ok, false);
  assert.equal(checkMandate(mandate, "").ok, false);
});

test("人叫停后立刻失效，而且理由留着", async () => {
  const { createMandate, revokeMandate, checkMandate, checkTicket, activeMandates } = await mod();
  const ws = tmp();
  const { mandate } = createMandate(ws, { ticketId: "T-3", scope: ["write"], now: T0 });
  const r = revokeMandate(ws, "T-3", { reason: "方向不对", now: T0 + 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.mandate.revokeReason, "方向不对");
  const after = checkMandate(r.mandate, "write", { now: T0 + 6000 });
  assert.equal(after.ok, false);
  assert.match(after.reason, /叫停/);
  // 现读现判也要是失效的：调用方不必自己盯盘
  assert.equal(checkTicket(ws, "T-3", "write", { now: T0 + 6000 }).ok, false);
  assert.equal(activeMandates(ws, { now: T0 + 6000 }).length, 0);
});

test("过期即失效；结束的活也算失效但不算撤销", async () => {
  const { createMandate, checkMandate, closeMandate, activeMandates } = await mod();
  const ws = tmp();
  const { mandate } = createMandate(ws, { ticketId: "T-4", scope: ["write"], ttlHours: 1, now: T0 });
  assert.equal(checkMandate(mandate, "write", { now: T0 + 2 * 3600_000 }).ok, false);
  assert.match(checkMandate(mandate, "write", { now: T0 + 2 * 3600_000 }).reason, /过期/);

  const c = closeMandate(ws, "T-4", { outcome: "completed", now: T0 + 1000 });
  assert.equal(c.mandate.closedAt, T0 + 1000);
  assert.equal(c.mandate.revokedAt, 0);
  assert.match(checkMandate(c.mandate, "write", { now: T0 + 2000 }).reason, /已经结束/);
  assert.equal(activeMandates(ws, { now: T0 + 2000 }).length, 0);
});

test("清理：过期超过 7 天且没结束的记录被移除，其余保留", async () => {
  const { createMandate, pruneMandates, getMandate, closeMandate } = await mod();
  const ws = tmp();
  createMandate(ws, { ticketId: "old", scope: ["write"], ttlHours: 1, now: T0 });
  createMandate(ws, { ticketId: "new", scope: ["write"], ttlHours: 1, now: T0 + 6 * 24 * 3600_000 });
  const r = pruneMandates(ws, { now: T0 + 9 * 24 * 3600_000 });
  assert.equal(r.removed, 1);
  assert.equal(getMandate(ws, "old"), null);
  assert.ok(getMandate(ws, "new"));

  createMandate(ws, { ticketId: "done", scope: ["write"], ttlHours: 1, now: T0 });
  closeMandate(ws, "done", { outcome: "stopped", now: T0 + 1000 });
  pruneMandates(ws, { now: T0 + 30 * 24 * 3600_000 });
  assert.ok(getMandate(ws, "done")); // 有结局的不清
});

test("工具面：读永远放行，写/命令/git/发布/花钱缺授权就裁掉", async () => {
  const { filterToolsByScope } = await mod();
  const tools = [
    { function: { name: "read" } }, { function: { name: "write" } }, { function: { name: "edit" } },
    { function: { name: "bash" } }, { function: { name: "gh" } }, { function: { name: "publish" } },
    { function: { name: "pay" } }, { name: "mystery_tool" },
  ];
  const ro = filterToolsByScope(tools, ["read"]);
  assert.deepEqual(ro.tools.map((t) => t.function?.name || t.name), ["read", "mystery_tool"]);
  assert.deepEqual(ro.dropped.sort(), ["bash", "edit", "gh", "pay", "publish", "write"]);

  const rw = filterToolsByScope(tools, ["read", "write"]);
  assert.deepEqual(rw.tools.map((t) => t.function?.name || t.name), ["read", "write", "edit", "mystery_tool"]);

  // 全权：一个都不裁
  assert.equal(filterToolsByScope(tools, ["write", "shell", "git", "publish", "spend"]).dropped.length, 0);
  // 空工具面不炸
  assert.deepEqual(filterToolsByScope(undefined, ["read"]), { tools: [], dropped: [] });
});
