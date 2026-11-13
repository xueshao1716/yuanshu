// 工具轮自查（2026-11-13）：重复调用 / 空返回 → 内部提示 + 换路继续，绝不中止。
// 用户原话：「哪怕是熔断，就是发现自己错了，立马分析重新补上正确的路，而不是不干了。」
import { test } from "node:test";
import assert from "node:assert/strict";
import { runYuanshuToolRound, isEmptyToolText, emptyResultText } from "../../engine/yuanshu-loop.mjs";

function tc(name, args = {}, id = undefined) {
  return { id: id || `${name}-${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function round({ history, seen = new Map(), toolCalls, execute, stuckEvents = [] }) {
  return runYuanshuToolRound({
    toolCalls,
    history,
    seenCalls: seen,
    stuckEvents,
    execute,
    policyDecide: () => ({ decision: "allow" }),
    jitForPath: () => [],
  });
}

const systems = (history) => history.filter(m => m.role === "system").map(m => String(m.content));
const lastTool = (history) => String(history.filter(m => m.role === "tool").pop()?.content || "");

test("同一工具 + 同参数连续 3 次：塞一条内部自查，不中断", async () => {
  const history = [];
  const seen = new Map();
  let r;
  for (let i = 0; i < 3; i++) {
    r = await round({ history, seen, toolCalls: [tc("bash", { command: "ls D:/tmp" }, `c${i}`)], execute: async () => ({ text: "a b c" }) });
    assert.equal(r.stop, undefined, "绝不在第 3 次停下来");
  }
  const notes = systems(history);
  assert.equal(notes.length, 1, "第 3 次正好一条自查");
  assert.match(notes[0], /内部自查/);
  assert.match(notes[0], /同一个调用已连续 3 次/);
  assert.match(notes[0], /上次返回：a b c/, "要贴上上次的返回摘要，她才知道这次有没有生效");
  assert.match(notes[0], /换一条路把事做完/);
  assert.doesNotMatch(notes[0], /停下来报告|请用户确认/);
  assert.match(lastTool(history), /\[自查\]/);
});

test("连续 5 次同参：仍然不中断（自查只在 3/6/9… 轮出现）", async () => {
  const history = [];
  const seen = new Map();
  for (let i = 0; i < 5; i++) {
    const r = await round({ history, seen, toolCalls: [tc("read", { path: "a.md" }, `r${i}`)], execute: async () => ({ text: "hello" }) });
    assert.equal(r.stop, undefined);
  }
  assert.equal(systems(history).length, 1, "4、5 次不重复刷屏，下一次自查在第 6 次");
});

test("参数不同就不触发自查（正常勘察不算重复）", async () => {
  const history = [];
  const seen = new Map();
  for (let i = 0; i < 5; i++) {
    const r = await round({ history, seen, toolCalls: [tc("bash", { command: `sed -n ${i * 40},${i * 40 + 40}p server.mjs` }, `d${i}`)], execute: async () => ({ text: `chunk ${i}` }) });
    assert.equal(r.stop, undefined);
  }
  assert.equal(systems(history).length, 0, "不同参数是正常推进，不许提示");
});

test("空输出：工具结果补一句'执行完成但没有输出'，不留白", async () => {
  const history = [];
  const r = await round({ history, toolCalls: [tc("bash", { command: "grep -rn nothing ." })], execute: async () => ({ text: "" }) });
  assert.equal(r.stop, undefined);
  const text = lastTool(history);
  assert.ok(text.trim().length > 0, "不许把空字符串原样回给模型");
  assert.match(text, /执行完成，但没有输出/);
  assert.match(text, /不是失败/);
  assert.match(text, /别原样重跑/);
  assert.equal(isEmptyToolText(text), false);
  assert.match(emptyResultText("bash"), /没有输出/);
});

test("连续 3 次空返回：同样给内部自查（不中止）", async () => {
  const history = [];
  const seen = new Map();
  for (let i = 0; i < 3; i++) {
    const r = await round({ history, seen, toolCalls: [tc("bash", { command: `grep -rn x${i} .` }, `e${i}`)], execute: async () => ({ text: "" }) });
    assert.equal(r.stop, undefined);
  }
  const notes = systems(history);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /连续 3 次空返回/);
  assert.match(notes[0], /参数没变|命令成功但没有输出/);
});

test("重复但一直失败：给提示，也依然不中断", async () => {
  const history = [];
  const seen = new Map();
  for (let i = 0; i < 5; i++) {
    const r = await round({
      history, seen,
      toolCalls: [tc("bash", { command: "npm run nope" }, `f${i}`)],
      execute: async () => ({ text: "npm ERR! missing script: nope", isError: true }),
    });
    assert.equal(r.stop, undefined);
  }
  const text = lastTool(history);
  assert.match(text, /系统提示|自查|失败/);
});
