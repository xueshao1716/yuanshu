// 工具轮长跑进度（2026-11-13）：每 10 轮给用户一条人话，别再让人 29 分钟盯着空屏。
// 用户原话：「最新的对话，执行了 44 轮了，没有反馈，究竟在干啥。」
// 44 轮是真实只读考古，不是死循环——缺的只是中途进度。这里锁住四条行为：
//   ① 只在 10/20/30… 的整数倍发，第 11 轮不刷；
//   ② 文案带轮数 + 最近工具/目标，且不出现"卡住/重试/中断"这类吓人的字；
//   ③ 一次对话最多 5 条（50 轮封顶），60 轮不再加；
//   ④ 没有 onNote、或正常 3-5 轮短对话：一条都不发，且 stop 语义完全不变。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runYuanshuToolRound } from "../../engine/yuanshu-loop.mjs";

const BANNED = /卡住|重试|中断/;

function tc(name, args, id) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** 连续工具轮执行器：同一份 history/seenCalls/stuckEvents，模拟一整轮对话里的 44 轮。 */
function makeRunner(history, notes) {
  const seenCalls = new Map();
  const stuckEvents = [];
  let id = 0;
  return async (name, args) => runYuanshuToolRound({
    toolCalls: [tc(name, args, `call-${++id}`)],
    history,
    seenCalls,
    stuckEvents,
    onNote: notes ? (note) => notes.push(note) : undefined,
    execute: async () => ({ text: "ok" }),
    policyDecide: () => ({ decision: "allow" }),
    jitForPath: () => [],
  });
}

/** 正常勘察的节奏：每轮工具/参数都不同，不能触发"重复调用"自查。 */
const survey = (round) => (round % 3 === 0
  ? ["bash", { command: `grep -rn "接口 ${round}" engine` }]
  : ["read", { path: `engine/file-${round}.mjs` }]);

test("每 10 轮一条：第 10 轮发第 1 条、第 20 轮发第 2 条，第 11 轮不刷", async () => {
  const history = [];
  const notes = [];
  const run = makeRunner(history, notes);
  for (let round = 1; round <= 19; round++) {
    const [name, args] = survey(round);
    const r = await run(name, args);
    assert.equal(r.stop, undefined, "进度提示不许改变停止语义");
    if (round < 10) assert.equal(notes.length, 0, `第 ${round} 轮不该发提示`);
    else if (round === 10) assert.equal(notes.length, 1, "第 10 轮正好发第 1 条");
    else assert.equal(notes.length, 1, `第 ${round} 轮不重复刷屏`);
  }
  assert.equal(notes[0].round, 10);
  assert.match(notes[0].text, /10 轮/);
  const [n20, a20] = survey(20);
  await run(n20, a20);
  assert.equal(notes.length, 2, "第 20 轮发第 2 条");
  assert.deepEqual(notes.map((n) => n.round), [10, 20]);
});

test("文案说清在干什么：含轮数与最近工具摘要，且不含卡住/重试/中断", async () => {
  const history = [];
  const notes = [];
  const run = makeRunner(history, notes);
  for (let round = 1; round <= 7; round++) await run("bash", { command: `sed -n ${round}p engine/a.mjs` });
  await run("read", { path: "D:/pi-web/frontend/src/components/Markdown.tsx" });
  await run("bash", { command: 'grep -rn "图片接口" frontend/src' });
  await run("read", { path: "frontend/src/components/Markdown.tsx" }); // 第 10 轮
  assert.equal(notes.length, 1);
  const note = notes[0];
  assert.equal(note.round, 10);
  assert.match(note.text, /已执行 10 轮工具/);
  assert.match(note.text, /仍在处理/);
  assert.match(note.text, /最近：/);
  assert.match(note.text, /grep -rn/, "要带最近一个工具的参数首行");
  assert.match(note.text, /Markdown\.tsx/, "要带最近动过的目标文件");
  assert.doesNotMatch(note.text, BANNED);
  assert.ok(note.text.length <= 80, "一条提示控制在一行，别写小作文");
  assert.ok(note.text.split(" / ").length <= 3, "摘要最多压最近 3 次工具");
});

test("50 轮后不再发：60 轮最多 5 条（10/20/30/40/50）", async () => {
  const history = [];
  const notes = [];
  const run = makeRunner(history, notes);
  for (let round = 1; round <= 60; round++) {
    const [name, args] = survey(round);
    const r = await run(name, args);
    assert.equal(r.stop, undefined);
  }
  assert.equal(notes.length, 5, "单轮对话最多 5 条，避免长跑刷屏");
  assert.deepEqual(notes.map((n) => n.round), [10, 20, 30, 40, 50]);
  assert.ok(notes.every((n) => !BANNED.test(n.text)));
});

test("没有 onNote 时不报错，也不影响工具轮本身", async () => {
  const history = [];
  const run = makeRunner(history, null);
  for (let round = 1; round <= 12; round++) {
    const [name, args] = survey(round);
    const r = await run(name, args);
    assert.equal(r.stop, undefined);
    assert.ok(r.toolPlan.length === 1);
  }
  assert.equal(history.filter((m) => m.role === "tool").length, 12, "工具结果照常回填");
});

test("正常 3-5 轮对话一条都不发", async () => {
  const history = [];
  const notes = [];
  const run = makeRunner(history, notes);
  for (let round = 1; round <= 5; round++) {
    const [name, args] = survey(round);
    await run(name, args);
  }
  assert.equal(notes.length, 0, "短对话不该冒出进度提示");
  assert.equal(history.filter((m) => m.role === "tool").length, 5);
});
