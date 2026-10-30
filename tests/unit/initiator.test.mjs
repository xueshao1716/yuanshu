// 发起者维度 + 策略判定（2026-10-30）
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeAction, currentInitiator, runWithInitiator, asInitiator, DEFAULT_RULES } from "../../engine/tools/initiator.mjs";

test("默认是 user，包一层就是 scheduler", async () => {
  assert.equal(currentInitiator(), "user");
  const seen = await runWithInitiator("scheduler", async () => currentInitiator());
  assert.equal(seen, "scheduler");
  assert.equal(currentInitiator(), "user", "出来后要还原");
});

test("并发不串：两个上下文同时跑各自看到自己的", async () => {
  const results = await Promise.all([
    runWithInitiator("scheduler", async () => { await new Promise((r) => setTimeout(r, 10)); return currentInitiator() }),
    runWithInitiator("user", async () => { await new Promise((r) => setTimeout(r, 5)); return currentInitiator() }),
  ]);
  assert.deepEqual(results, ["scheduler", "user"]);
});

test("asInitiator 包函数：调用时自动切上下文", async () => {
  const f = asInitiator("scheduler", async () => currentInitiator());
  assert.equal(await f(), "scheduler");
});

test("规则：定时任务删东西被拒，人让做的放行", () => {
  const rules = [{ id: "r1", initiator: ["scheduler"], deny: ["bash:rm\\s+-rf"], reason: "定时任务不许删" }];
  assert.equal(judgeAction({ tool: "bash", args: { command: "rm -rf /tmp/x" }, initiator: "scheduler", rules }).allow, false);
  assert.equal(judgeAction({ tool: "bash", args: { command: "rm -rf /tmp/x" }, initiator: "user", rules }).allow, true);
});

test("规则：只写工具名时按工具匹配（不论参数）", () => {
  const rules = [{ id: "r2", initiator: ["scheduler"], deny: ["notify_user"], reason: "定时任务不许对外发" }];
  assert.equal(judgeAction({ tool: "notify_user", args: { text: "hi" }, initiator: "scheduler", rules }).allow, false);
  assert.equal(judgeAction({ tool: "bash", args: {}, initiator: "scheduler", rules }).allow, true);
});

test("没命中任何规则就放行", () => {
  assert.equal(judgeAction({ tool: "read", args: { path: "a" }, initiator: "scheduler", rules: DEFAULT_RULES }).allow, true);
});

test("默认策略：定时任务不许删东西、不许对外发消息", () => {
  assert.equal(judgeAction({ tool: "bash", args: { command: "rm -rf build" }, initiator: "scheduler", rules: DEFAULT_RULES }).allow, false);
  assert.equal(judgeAction({ tool: "notify_user", args: {}, initiator: "scheduler", rules: DEFAULT_RULES }).allow, false);
  assert.equal(judgeAction({ tool: "bash", args: { command: "rm -rf build" }, initiator: "user", rules: DEFAULT_RULES }).allow, true);
  assert.equal(judgeAction({ tool: "notify_user", args: {}, initiator: "user", rules: DEFAULT_RULES }).allow, true);
});

test("返回里带规则 id 和理由（拒绝时能说清是哪条）", () => {
  const r = judgeAction({ tool: "bash", args: { command: "del a.txt" }, initiator: "scheduler", rules: DEFAULT_RULES });
  assert.equal(r.allow, false);
  assert.equal(r.ruleId, "no-scheduler-destructive");
  assert.match(r.reason, /删东西/);
});
