// 元枢引擎模块接线契约（2026-09-14）
// 背景：2026-08-20 那批「从 server.mjs 拆出」的重构普遍存在**裸引用漏搬**——
// 标识符在模块里被使用，却既没 import 也没注入，运行到那行才 ReferenceError。
// stats-api.mjs:13 已记录过一次同类事故（三个 API 坏了 9 天）。本文件锁住已修好的关键路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initSessionManager, evictInactiveSessions } from "../../engine/session/manager.mjs";
import { createRepairCheckpoint, initSelfHeal, repoRoot } from "../../engine/self-heal.mjs";
import { flashCandidate, routeForAuto } from "../../engine/model/router.mjs";
import { taskProgress, touchTask, clearTask } from "../../engine/unified-chat.mjs";

const MAX_ACTIVE = 30; // 与 session-manager.mjs 的 MAX_ACTIVE_SESSIONS 对齐

function fakeEntry(lastUsed, busy = false) {
  return { lastUsed, busy, agent: { dispose() {} } };
}

test("evictInactiveSessions：活动会话超上限时能淘汰最久未用（不得 ReferenceError）", () => {
  const map = new Map();
  for (let i = 0; i < 35; i++) map.set("s" + i, fakeEntry(i));
  initSessionManager({ activeSessions: map });
  assert.doesNotThrow(() => evictInactiveSessions(), "超上限时不得抛（裸引用 activeSessions 会 ReferenceError）");
  assert.ok(map.size <= MAX_ACTIVE, `淘汰后应 <= ${MAX_ACTIVE}，实际 ${map.size}`);
  assert.ok(!map.has("s0"), "最久未用的 s0 应被淘汰");
});

test("evictInactiveSessions：未超上限时原样保留", () => {
  const map = new Map();
  for (let i = 0; i < 5; i++) map.set("s" + i, fakeEntry(i));
  initSessionManager({ activeSessions: map });
  assert.doesNotThrow(() => evictInactiveSessions());
  assert.equal(map.size, 5);
});

test("evictInactiveSessions：busy 的会话一律不淘汰", () => {
  const map = new Map();
  for (let i = 0; i < 35; i++) map.set("s" + i, fakeEntry(i, true));
  initSessionManager({ activeSessions: map });
  assert.doesNotThrow(() => evictInactiveSessions());
  assert.equal(map.size, 35, "全部 busy 时不得淘汰任何会话");
});

test("createRepairCheckpoint：备份清单不得为空，且以 repoRoot() 为基准", () => {
  initSelfHeal({ cwd: repoRoot() });
  const cp = createRepairCheckpoint();
  assert.ok(!cp.error, `检查点创建失败: ${cp.error}`);
  assert.ok(cp.dir && cp.dir.startsWith(repoRoot()), `备份目录应位于 repoRoot() 下，实际 ${cp.dir}`);
  const files = fs.readdirSync(cp.dir);
  // 清单为空（_repairFiles 自赋值 bug）时这里一个文件都不会有
  assert.ok(files.includes("server.mjs"), `应备份 server.mjs，实际备份了: ${files.join(", ") || "(空)"}`);
  assert.ok(files.length >= 3, `应备份多个源码文件，实际 ${files.length} 个`);
  fs.rmSync(cp.dir, { recursive: true, force: true }); // 清理本次测试产物
});

test("model-router 导出 flashCandidate（server.mjs 依赖它做主动探测）", () => {
  assert.equal(typeof flashCandidate, "function");
  const r = routeForAuto("你好", "sess-export-check");
  assert.ok(r && r.model !== undefined, "routeForAuto 应返回模型决策");
});

test("unified-chat 导出 taskProgress（server.mjs /api/tasks/active 依赖它）", () => {
  assert.ok(taskProgress instanceof Map, "taskProgress 必须是 Map（断线自恢复轮询读它）");
  touchTask("sess-task-check", { stage: "测试中" });
  assert.equal(taskProgress.get("sess-task-check")?.stage, "测试中");
  assert.equal(taskProgress.get("sess-task-check")?.status, "running");
  clearTask("sess-task-check", "done");
  assert.equal(taskProgress.get("sess-task-check")?.status, "done");
});
