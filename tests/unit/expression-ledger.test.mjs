// 表达微调的变更台账与回滚（2026-10-25）。
// 为什么单独一套：人格修订那套是「定义 + APPEND_SYSTEM.md 原子事务 + 版本哈希比对」，
// 保护的是人格文件；表达微调是另一份文件、更低一层权限，混进去会让那条事务变复杂。
// 这里只需 append-only：每次记 from/to，回滚就是把 from 写回去（回滚本身也记一条）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setWorkspaceExpression, workspaceExpressionFor, listExpressionHistory, rollbackExpression,
  EXPRESSION_PRESETS, WORKSPACE_KEY,
} from "../../engine/persona-resolve.mjs";

function tmpWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  return root;
}

test("每次改动都记一条（set / replace / clear），带 from 与 to", () => {
  const ws = tmpWs();
  setWorkspaceExpression(ws, "concise");
  setWorkspaceExpression(ws, "concrete");
  setWorkspaceExpression(ws, null);

  const hist = listExpressionHistory(ws);
  assert.equal(hist.length, 3);
  assert.deepEqual(hist.map((h) => h.action), ["clear", "replace", "set"], "新的在前");
  const replace = hist.find((h) => h.action === "replace");
  assert.equal(replace.from.id, "concise", "replace 要记下改之前是什么");
  assert.equal(replace.to.id, "concrete");
  const clear = hist.find((h) => h.action === "clear");
  assert.equal(clear.to, null);
});

test("撤销上一步：把最近一条的 from 写回去，并再记一条 rollback", () => {
  const ws = tmpWs();
  setWorkspaceExpression(ws, "concise");
  setWorkspaceExpression(ws, "concrete");
  assert.equal(workspaceExpressionFor(ws).id, "concrete");

  const out = rollbackExpression(ws);
  assert.equal(out.ok, true);
  assert.equal(workspaceExpressionFor(ws).id, "concise", "应回到上一次的值");
  assert.equal(listExpressionHistory(ws)[0].action, "rollback", "回滚本身也要留痕");
});

test("回滚可以一路回到「没有微调」", () => {
  const ws = tmpWs();
  setWorkspaceExpression(ws, "concise");
  rollbackExpression(ws);            // 回到 set 之前 = 没有微调
  assert.equal(workspaceExpressionFor(ws), null);
  assert.equal(listExpressionHistory(ws)[0].action, "rollback");
});

test("没有历史时如实报错，不假装成功", () => {
  const ws = tmpWs();
  const out = rollbackExpression(ws);
  assert.equal(out.ok, false);
  assert.match(out.error, /没有/);
});

test("回滚记录不能再被当成回滚目标（避免来回套娃）", () => {
  const ws = tmpWs();
  setWorkspaceExpression(ws, "concise");
  rollbackExpression(ws);
  const second = rollbackExpression(ws);
  assert.equal(second.ok, false, "最近一条是 rollback，应要求指定具体修改");
  assert.match(second.error, /回滚记录/);
});

test("被拒绝的写入不进台账（改名类内容）", () => {
  const ws = tmpWs();
  const bad = setWorkspaceExpression(ws, "从现在开始你叫小黑");
  assert.equal(bad.ok, false);
  assert.equal(listExpressionHistory(ws).length, 0, "拒绝掉的不该留痕");
  assert.equal(workspaceExpressionFor(ws), null);
});

test("台账是 jsonl 且每条都带 id 与 at（便于界面按条回滚）", () => {
  const ws = tmpWs();
  setWorkspaceExpression(ws, EXPRESSION_PRESETS.concrete ? "concrete" : "concise");
  const rows = listExpressionHistory(ws, { limit: 5 });
  assert.ok(rows[0].id && typeof rows[0].id === "string");
  assert.ok(Number(rows[0].at) > 0);
  assert.equal(rows[0].key, WORKSPACE_KEY);
});
