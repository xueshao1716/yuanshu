// 记忆结算的引擎路径对等 —— 源码级意图锁
//
// 被锁住的历史缺陷：记忆结算原先只写在 server.mjs 的 Pi 分支 try 里，
// 而 Pi 分支位于 handleChat early-return **之后** →
//   · yuanshu(unified) 路径静默不写记忆
//   · dsh 路径同样不写
//   · Pi 失败降级到 unified 时也被一起跳过（那段代码在 try 内，catch 走降级不再回头）
// 而 engine/engine-pair.mjs 的引擎目录声明的恰恰相反：
//   yuanshu → 「记忆、出图、规划…都挂在这条上」
//   pi      → 「记忆、出图、规划不在这条循环里长」
// 实现与声明是反的。默认主驾是 pi，所以一直能跑，缺口才没被发现。
//
// 现在的契约：pi 与 yuanshu 都结算；dsh 按它自己声明的边界不结算。
// 运行：node --test tests/unit/memory-path-parity.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const server = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
const turnMemory = fs.readFileSync(path.join(root, "engine", "turn-memory.mjs"), "utf8");
const enginePair = fs.readFileSync(path.join(root, "engine", "engine-pair.mjs"), "utf8");

describe("记忆结算只应有一份实现", () => {
  test("实现落在 engine/turn-memory.mjs，server.mjs 不再内联", () => {
    assert.match(turnMemory, /export async function settleTurnMemory/, "结算实现应在 engine/turn-memory.mjs");
    assert.match(turnMemory, /mem\.autoMemorize\(/, "autoMemorize 应由该模块调用");
    assert.equal((server.match(/autoMemorize\(/g) || []).length, 0, "server.mjs 不该再内联调用 autoMemorize");
    assert.equal((server.match(/const assistLatest = \(\(\) =>/g) || []).length, 0,
      "整份回读会话找最后一条助手消息的旧写法已被按偏移切片取代");
  });

  test("每轮恰好结算一次：早返回分支与 Pi 分支各一处", () => {
    assert.equal((server.match(/await settleTurnMemory\(/g) || []).length, 2,
      "两处调用：unified 分支的 finally 与 Pi 分支的 finally。多一处会重复记账，少一处就有路径漏写");
  });
});

describe("两个分支都要结算", () => {
  test("unified/dsh 早返回分支在 finally 里结算", () => {
    const start = server.indexOf('if (forceResumeUnified || engineDecision.lead === "dsh"');
    assert.ok(start > 0, "找不到早返回分支");
    const end = server.indexOf("\n    return;", start);
    assert.ok(end > start, "找不到早返回分支的 return");
    const branch = server.slice(start, end);
    assert.match(branch, /await settleTurnMemory\(/, "unified 路径必须结算——引擎目录说记忆就挂在它这条上");
    assert.match(branch, /if \(entry\.gen === thisGen\)/, "被新请求顶掉的轮次不该结算（会按偏移切到新轮次的回复）");
  });

  test("dsh 按它声明的边界被排除", () => {
    const gate = server.match(/const ranUnifiedLoop = !\(engineDecision\.lead === "dsh"[^\n]*/);
    assert.ok(gate, "必须有显式的 dsh 排除闸门");
    // 闸门要与引擎目录保持一致：dsh 不可主驾，且明确「不接记忆 / 出图 / 规划主循环」。
    // 按条目边界切片，不写死字窗——目录文案会变长。
    const start = enginePair.indexOf("dsh: {");
    const end = enginePair.indexOf("\n  },", start);
    assert.ok(start > 0 && end > start, "找不到 dsh 目录条目");
    const entry = enginePair.slice(start, end);
    assert.match(entry, /canLead: false/, "dsh 已定为不可主驾；若改回可主驾，这里的闸门要一起重新考虑");
    assert.match(entry, /不接记忆/, "dsh 的声明必须仍写着不接记忆");
  });

  test("Pi 分支的 finally 结算，覆盖成功与降级两种情况", () => {
    const anchor = server.indexOf('clearTask(taskId, "done"); // 兜底');
    assert.ok(anchor > 0, "找不到 Pi 分支 finally 的兜底 clearTask");
    const tail = server.slice(anchor, anchor + 900);
    assert.match(tail, /await settleTurnMemory\(/,
      "Pi 失败会 catch 后降级到 unifiedChat，那段代码在 try 内不会再回来——所以结算必须在 finally");
  });
});

describe("只认本轮新追加的助手回复", () => {
  test("按字节偏移切片，而不是整份回读", () => {
    // let 而不是 const：上下文余量闸门压缩会话后会改写文件，偏移必须能重算
    assert.match(server, /let sessionBytesBefore = \(\(\) =>/, "本轮开始前必须记录会话文件偏移");
    assert.match(turnMemory, /export function readAppendedAssistantText\(file, fromByte/);
  });

  test("没有本轮助手回复时直接返回，不复用上一轮文本", () => {
    assert.match(turnMemory, /if \(!assistLatest\) return \{ settled: false, reason: "本轮无助手回复" \}/);
  });
});
