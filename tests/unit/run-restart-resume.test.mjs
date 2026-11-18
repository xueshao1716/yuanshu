// 复现（2026-11-17 实测）：主运行跑到一半重启服务，重启后状态是 interrupted、resumeAvailable:false、
// backgroundRecovery 停在 ready/used:0——自动续从来没触发过。
// 原因：server.mjs 顶层的"残留运行收尾"在 runManager 建好之前就把聊天运行改成 interrupted，
// 等 listen 回调里 runManager.recover() 再找孤儿时已经一条都不剩，trySchedule 根本没机会跑。
// 修法：顶层收尾只管内部轮次；聊天运行留给 recover()（它会补 resumeAvailable + 检查点 + 自动续）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const server = readFileSync(join(import.meta.dirname, "..", "..", "server.mjs"), "utf8");

test("启动收尾不抢 runManager.recover() 的活：聊天运行不在顶层被改成 interrupted", () => {
  const start = server.indexOf("const stale = runStore.list({ includeInternal: true })");
  assert.ok(start > 0, "找不到启动收尾代码块");
  const block = server.slice(start, server.indexOf("} catch (e) { console.log('[recover] 残留运行清理跳过", start));
  assert.match(block, /r\.kind [!=]== ['"]internal['"]/, "只收内部轮次");
  assert.doesNotMatch(block, /runStore\.update\(r\.id, \{ status: 'interrupted'/, "聊天运行不能在这里被标成中断（那样 recover() 就找不到它了）");
  assert.ok(server.indexOf("runManager.recover(") > start, "聊天运行的孤儿由 listen 后的 recover 处理");
});
