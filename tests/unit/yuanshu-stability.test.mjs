// 元枢循环再稳：空回合有界重试、截断 tool JSON 立刻停、工具执行吃 abort
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_EMPTY_TURN_RETRIES,
  EMPTY_TURN_ERROR,
  TRUNCATED_TOOL_ERROR,
  isEmptyAssistantTurn,
  emptyTurnDecision,
  inspectToolCalls,
  execFileAbortable,
} from "../../engine/yuanshu-stability.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

test("空回合：无工具且无正文才算空", () => {
  assert.equal(isEmptyAssistantTurn({ text: "", hasTools: false }), true);
  assert.equal(isEmptyAssistantTurn({ text: "  ", hasTools: false }), true);
  assert.equal(isEmptyAssistantTurn({ text: "你好", hasTools: false }), false);
  assert.equal(isEmptyAssistantTurn({ text: "", hasTools: true }), false);
});

test("空回合：同一模型最多重试 3 次，第 3 次空才耗尽", () => {
  assert.equal(MAX_EMPTY_TURN_RETRIES, 3);
  assert.equal(emptyTurnDecision(1), "retry");
  assert.equal(emptyTurnDecision(2), "retry");
  assert.equal(emptyTurnDecision(3), "exhausted");
  assert.equal(emptyTurnDecision(4), "exhausted");
});

test("inspectToolCalls：合法调用放行", () => {
  const r = inspectToolCalls([
    { id: "1", function: { name: "read", arguments: '{"path":"a.txt"}' } },
  ]);
  assert.equal(r.truncated, false);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].function.name, "read");
});

test("inspectToolCalls：arguments 截断成半截 JSON 必须标 truncated", () => {
  const r = inspectToolCalls([
    { id: "1", function: { name: "write", arguments: '{"path":"a.html","content":"<div' } },
  ]);
  assert.equal(r.truncated, true);
  assert.equal(r.calls.length, 0);
});

test("inspectToolCalls：缺 name / 缺 function 也算截断", () => {
  assert.equal(inspectToolCalls([{ id: "1", function: { arguments: "{}" } }]).truncated, true);
  assert.equal(inspectToolCalls([{ id: "1" }]).truncated, true);
});

test("execFileAbortable：abort 必须杀掉已启动的子进程", async () => {
  const ac = new AbortController();
  const started = Date.now();
  const p = execFileAbortable(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    timeout: 300000,
    windowsHide: true,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 80);
  await assert.rejects(p, (e) => e?.aborted === true || e?.killed === true || /abort/i.test(String(e?.message || e)));
  assert.ok(Date.now() - started < 8000, "断开后不能再等满超时");
});

// 2026-09-16：命令是经 shell 包一层起的（cmd /c 或 bash -lc），真正干活的是**孙子进程**。
// 只杀 shell 会把它变成孤儿继续跑——真机上表现成"点了停止还在跑"、临时目录删不掉、
// 以及 abort 用例被拖到 30s。
//
// 2026-09-17 修过一次本身的 flaky：cmd 那支原来 ping 的是 127.0.0.99，本机会立刻回
// "Destination host unreachable"，命令 400ms 内就跑完了 → abort 还没发，promise 已经 resolve，
// 断言报 "Missing expected rejection"（全量里偶发）。改成：
//   · cmd 支 ping **回环地址**（30 次 ≈ 30s，稳定长跑），查存活用 PING.EXE 数量差（不加引号、不需标记）；
//   · bash 支仍用命令行里的唯一标记（bash 引号没问题，能直接跑 node -e）。
test("execFileAbortable：abort 要连孙子进程一起杀（cmd / bash 包一层也不留孤儿）", { skip: process.platform !== "win32" }, async () => {
  const { execFile } = await import("node:child_process");
  const { detectBashShell } = await import("../../engine/tools/unified-tools.mjs");
  const marker = `piweb-orphan-${process.pid}-${Date.now()}`;
  const count = (psQuery) => new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", psQuery],
      (err, out) => resolve(err ? -1 : Number(String(out).trim())));
  });
  const pingCount = () => count(`(Get-Process ping -ErrorAction SilentlyContinue | Measure-Object).Count`);
  const survivors = (needle) => count(
    // 必须排掉 powershell 自己：这条查询的命令行里就带着 needle，会自己匹配自己。
    `(Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and $_.Name -ne 'pwsh.exe' -and $_.CommandLine -like '*${needle}*' } | Measure-Object).Count`);

  const cases = [["cmd", process.env.ComSpec || "cmd.exe", ["/c", "ping -n 30 127.0.0.1"], pingCount]];
  const bash = detectBashShell();
  // bash 里含空格的 Windows 路径**必须加引号**：`C:\Program Files\nodejs\node.exe` 不加引号会被
  // bash 拆成 `C:\Program` + `Files\...`，命令 360ms 就以 127（command not found）退出——
  // abort 还没发就 resolve，断言于是报 "Missing expected rejection"（这个用例偶发红就是这么来的）。
  const nodeExe = `"${process.execPath}"`;
  if (bash) cases.push(["bash", bash, ["-lc", `${nodeExe} -e "setTimeout(()=>{},30000)//${marker}"`], () => survivors(marker)]);

  for (const [label, file, args, alive] of cases) {
    const before = await alive();
    const ac = new AbortController();
    const p = execFileAbortable(file, args, { timeout: 300000, windowsHide: true, signal: ac.signal });
    setTimeout(() => ac.abort(), 400); // 等孙子进程真的起来再断
    await assert.rejects(p, (e) => e?.aborted === true || e?.killed === true || /abort/i.test(String(e?.message || e)));
    let left = await alive();
    for (let i = 0; i < 20 && left > before; i++) {
      await new Promise((r) => setTimeout(r, 250));
      left = await alive();
    }
    assert.ok(left <= before, `${label}：abort 5s 后还有孤儿进程在跑（${left} > 基线 ${before}）`);
  }
});

test("unifiedChat 必须接上空回合重试、截断停、工具 abort", () => {
  const chat = read("engine", "unified-chat.mjs");
  const loop = read("engine", "yuanshu-loop.mjs");
  const tools = read("engine", "tools", "unified-tools.mjs");
  const sched = read("engine", "tool-scheduler.mjs");
  assert.ok(chat.includes("inspectToolCalls") && chat.includes("TRUNCATED_TOOL_ERROR"), "截断 tool JSON 必须立刻停");
  assert.ok(chat.includes("emptyTurnDecision") && chat.includes("EMPTY_TURN_ERROR"), "空回合必须有界重试");
  assert.ok(chat.includes("result.empty") || chat.includes("empty: true"), "空回合耗尽要标 empty 给外层兑底");
  assert.ok(loop.includes("execute(name, args,") && loop.includes("signal"), "工具轮要把 abort 传进执行器");
  assert.ok(sched.includes("execute(fnName, args") && sched.includes("signal"), "调度器必须把 signal 传给 execute");
  assert.ok(tools.includes("execFileAbortable"), "bash 必须走可中止的 exec");
});
