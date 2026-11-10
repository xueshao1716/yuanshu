// 2026-11-10 P1-3：工具事件潮汐的写盘频率
// 缺口（实测）：一轮十几次工具调用 = 十几次 applyEvent = 十几次 appendFileSync（全挡在事件循环上）；
//              收尾 recordFeeling 之后还整份 readFileSync 情绪感受（实测 225KB）。
// 现在：事件潮汐进内存缓冲（上限 200 行），收尾队列一次 flush；感受的行数判断用内存计数器，
//      文件被外部删/截断/追加时按 stat 对账自愈（整份重读一次）。
// 这里用 fs 桩数 append/read 次数，断言的是"真的少写了/少读了"，不是只读源码。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEvent, clearEmotion, flushTideBuffer, getTide, init, recordFeeling,
} from "../../engine/emotion.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "emo-tide-buf-"));
const tideFile = (root) => path.join(root, "记忆", "情绪潮汐.jsonl");
const feelingsFile = (root) => path.join(root, "记忆", "情绪感受.jsonl");
const linesOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);

// fs 桩：只统计目标文件的 appendFileSync 调用，其余原样透传（和 emotion.mjs 共用同一个 fs 对象）。
function stubAppends(t, target) {
  const orig = fs.appendFileSync;
  const calls = [];
  fs.appendFileSync = function (file, data, ...rest) {
    if (path.resolve(String(file)) === path.resolve(target)) calls.push(String(data));
    return orig.call(this, file, data, ...rest);
  };
  t.after(() => { fs.appendFileSync = orig; });
  return calls;
}

// fs 桩：只统计目标文件的 readFileSync 次数（整份读）；read() 走原函数，断言自己的读不算进去。
function stubReads(t, target) {
  const orig = fs.readFileSync;
  const calls = [];
  fs.readFileSync = function (file, ...rest) {
    if (path.resolve(String(file)) === path.resolve(target)) calls.push(String(file));
    return orig.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = orig; });
  return { calls, read: (file) => orig.call(fs, file, "utf8") };
}

test("连续 10 次事件不写盘；flush 一次 append、读到 10 行", (t) => {
  const root = tmpRoot();
  init(root);
  clearEmotion("tide-buf");
  const calls = stubAppends(t, tideFile(root));
  for (let i = 0; i < 10; i++) applyEvent("success", { sessionId: "tide-buf" });

  assert.equal(calls.length, 0, "10 次事件还没到收尾，不应该有 append（旧实现是 10 次）");
  // 未落盘的行也要能被读到：工作台曲线/观测不比内存状态旧
  assert.equal(getTide(50).filter((p) => p.source === "event:success").length, 10, "未 flush 的事件 getTide 要读得到");

  assert.equal(flushTideBuffer(), 10, "flush 返回本次落盘行数");
  assert.equal(calls.length, 1, "10 次事件只产生 1 次 append");
  const events = linesOf(tideFile(root)).map((line) => JSON.parse(line)).filter((p) => String(p.source || "").startsWith("event:"));
  assert.equal(events.length, 10, "flush 后可读出 10 行事件");
  assert.equal(events[0].source, "event:success");
  assert.equal(events[0].key, "tide-buf");

  assert.equal(flushTideBuffer(), 0, "空缓冲不写空盘");
  assert.equal(calls.length, 1, "重复 flush 不得多一次 append");
});

test("缓冲上限 200 行：到顶自动落一次，不无限涨", (t) => {
  const root = tmpRoot();
  init(root);
  clearEmotion("tide-cap");
  const calls = stubAppends(t, tideFile(root));
  for (let i = 0; i < 240; i++) applyEvent("success", { sessionId: "tide-cap" });

  assert.equal(calls.length, 1, "第 200 条时要自动落盘一次（防无人收尾时泄漏）");
  assert.equal(flushTideBuffer(), 40, "剩下 40 条留给收尾 flush");
  assert.equal(calls.length, 2);

  const events = linesOf(tideFile(root)).map((line) => JSON.parse(line)).filter((p) => String(p.source || "").startsWith("event:"));
  assert.equal(events.length, 240, "一条都不能丢");
});

test("recordFeeling：10 次追加只整份读 1 次；外部改动后按文件大小自愈重读", (t) => {
  const root = tmpRoot();
  init(root);
  clearEmotion("feel-count");
  const f = feelingsFile(root);
  const stub = stubReads(t, f);
  const countLines = () => stub.read(f).trim().split("\n").filter(Boolean).length;

  for (let i = 0; i < 10; i++) recordFeeling("feel-count", `第 ${i} 条感受`);
  assert.equal(stub.calls.length, 1, "10 次追加只允许 1 次整份读（进程内首次对齐），旧实现是 10 次");
  assert.equal(countLines(), 10);

  // 外部追加 3 行：内存计数器与文件大小不符 → 下一次追加必须重读一次对齐
  fs.appendFileSync(f, "x\n".repeat(3), "utf8");
  recordFeeling("feel-count", "外部改过之后");
  assert.equal(stub.calls.length, 2, "大小不符要重读一次");
  assert.equal(countLines(), 14);

  // 对齐之后继续只用计数器（不再整份读）
  recordFeeling("feel-count", "对齐之后");
  assert.equal(stub.calls.length, 2, "对齐后不该再整份读");
  assert.equal(countLines(), 15);
});

test("recordFeeling：文件被外部截断/删掉也能自愈", (t) => {
  const root = tmpRoot();
  init(root);
  clearEmotion("feel-heal");
  const f = feelingsFile(root);

  for (let i = 0; i < 5; i++) recordFeeling("feel-heal", `正常 ${i}`);
  // 截断到 2 行
  fs.writeFileSync(f, linesOf(f).slice(-2).join("\n") + "\n", "utf8");
  recordFeeling("feel-heal", "截断之后");
  assert.equal(linesOf(f).length, 3, "截断后按真实文件重数：2 + 1");

  // 整个删掉：下一次追加重建文件
  fs.rmSync(f);
  recordFeeling("feel-heal", "删掉之后");
  assert.equal(linesOf(f).length, 1, "删掉后重建文件只应有这一行");
});

test("接线（静态断言）：收尾队列 flush 一次，进程退出钩子再兜一次", () => {
  const chat = fs.readFileSync(path.join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const start = chat.indexOf("const runCloseout = () => {");
  assert.ok(start > 0, "runCloseout 还在");
  assert.ok(chat.slice(start, start + 5000).includes("flushTideBuffer()"), "收尾任务里必须 flush 潮汐缓冲");
  assert.ok(chat.includes('import { applyEvent, flushTideBuffer } from "./emotion.mjs"'), "flush 要从 emotion.mjs 引入");

  const emo = fs.readFileSync(path.join(ROOT, "engine", "emotion.mjs"), "utf8");
  assert.ok(/process\.once\(\s*["']exit["']/.test(emo), "进程退出钩子要兜底 flush");
  assert.ok(emo.includes("TIDE_BUFFER_MAX = 200"), "缓冲必须有上限（防泄漏）");
});
