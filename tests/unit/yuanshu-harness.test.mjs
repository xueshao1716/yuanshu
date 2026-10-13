import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTodos, readTodos, formatTodoPrompt, bindTodoSession } from "../../engine/yuanshu-todo.mjs";
import { recordStuckEvent, detectStuck } from "../../engine/yuanshu-stuck.mjs";
import { matchSkillsForTask, buildYuanshuContext } from "../../engine/yuanshu-protocol.mjs";
import { needsMidLoopCompact } from "../../engine/model-client.mjs";
import { runYuanshuToolRound } from "../../engine/yuanshu-loop.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("todo_write 整表覆盖，format 给模型看当前清单", () => {
  bindTodoSession("sess-todo");
  writeTodos([{ content: "写脚本", status: "in_progress" }, { content: "出片", status: "pending" }]);
  const list = readTodos();
  assert.equal(list.length, 2);
  assert.equal(list[0].status, "in_progress");
  assert.match(formatTodoPrompt(), /写脚本/);
  assert.match(formatTodoPrompt(), /出片/);
});

test("matchSkillsForTask：做个视频要命中视频技能，嗯不瞎配", () => {
  const skills = [
    { name: "aigc-video-production", desc: "视频创作流水线" },
    { name: "wanxiang-portrait", desc: "人物写真" },
  ];
  const hit = matchSkillsForTask("做个视频，主题爱而不得", skills);
  assert.ok(hit.some(s => s.name === "aigc-video-production"));
  assert.equal(matchSkillsForTask("嗯", skills).length, 0);
  const ctx = buildYuanshuContext({ message: "做个视频", skills });
  assert.ok(ctx.some(s => /activate_skill/.test(s) && /aigc-video-production/.test(s)));
});

test("detectStuck：同一动作观察重复 4 次，或 ABAB，或同工具连错 4 次", () => {
  const same = [];
  for (let i = 0; i < 4; i++) same.push(recordStuckEvent("read", { path: "a.md" }, { text: "hello", isError: false }));
  assert.match(detectStuck(same).hint, /循环|重复/);
  const ab = [];
  for (let i = 0; i < 3; i++) {
    ab.push(recordStuckEvent("read", { path: "a" }, { text: "A" }));
    ab.push(recordStuckEvent("read", { path: "b" }, { text: "B" }));
  }
  assert.match(detectStuck(ab).hint, /交替|循环/);
  const errs = [];
  for (let i = 0; i < 4; i++) errs.push(recordStuckEvent("bash", { command: `curl ${i}` }, { text: "fail", isError: true }));
  assert.match(detectStuck(errs).hint, /失败|换/);
  assert.equal(detectStuck([recordStuckEvent("read", { path: "x" }, { text: "ok" })]), null);
});

test("needsMidLoopCompact：中段够长才压，刚压过要歇几轮", () => {
  const long = Array.from({ length: 16 }, (_, i) => ({ role: "user", content: "x".repeat(2000) + i }));
  assert.equal(needsMidLoopCompact(long, { turn: 8, lastCompactTurn: 0 }), true);
  assert.equal(needsMidLoopCompact(long, { turn: 8, lastCompactTurn: 6 }), false);
  assert.equal(needsMidLoopCompact([{ role: "user", content: "hi" }], { turn: 20, lastCompactTurn: 0 }), false);
});

test("runYuanshuToolRound 卡住必须停，不要再空转", async () => {
  const history = [];
  const stuckEvents = [];
  let calls = 0;
  for (let i = 0; i < 4; i++) {
    const r = await runYuanshuToolRound({
      toolCalls: [{ id: String(i), type: "function", function: { name: "read", arguments: "{\"path\":\"a.md\"}" } }],
      history,
      stuckEvents,
      execute: async () => { calls += 1; return { text: "hello", isError: false }; },
      policyDecide: () => ({ decision: "allow" }),
      jitForPath: () => [],
    });
    if (r.stop) {
      assert.match(String(r.stop.error), /循环|重复|卡住/);
      assert.ok(calls <= 4);
      return;
    }
  }
  assert.fail("4 次相同 read 必须停");
});

test("主工具表必须挂上 todo 和 delegate_task", () => {
  const src = readFileSync(join(ROOT, "server.mjs"), "utf8");
  assert.ok(src.includes("TODO_TOOL_SCHEMAS") || src.includes("todo_write"), "Claude 式清单必须进主工具表");
  assert.ok(src.includes("plan_files") || src.includes("PLAN_FILES_SCHEMA"), "磁盘工作记忆必须进主工具表");
  assert.ok(src.includes("delegate_task") || src.includes("DELEGATE_TASK"), "OpenHands 式子代理必须能被模型调用");
});

test("handleUnifiedChat Auto 必须走 routeForAuto，循环中段必须能压缩", () => {
  const src = readFileSync(join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const start = src.indexOf("export async function handleUnifiedChat");
  const fn = src.slice(start, start + 9000);
  assert.ok(fn.includes("routeForAuto"), "元枢兑底不能只会 pickFallbackDefault");
  const loop = src.slice(src.indexOf("export async function unifiedChat"), src.indexOf("export async function unifiedChat") + 12000);
  assert.ok(loop.includes("needsMidLoopCompact") || loop.includes("maybeCompactHistory"), "中段要压上下文，不能等开场那一次");
  assert.ok(loop.includes("compactKeepArchive"), "压缩必须留 archive，不能只换成摘要");
  const handle = src.slice(src.indexOf("export async function handleUnifiedChat"), src.indexOf("export async function handleUnifiedChat") + 16000);
  assert.ok(handle.includes("assembleYuanshuSystem") || handle.includes("buildYuanshuSections"), "system 必须走命名区段");
  assert.ok(handle.includes("sandboxMode"), "规划只读要落到沙箱阶梯");
});
