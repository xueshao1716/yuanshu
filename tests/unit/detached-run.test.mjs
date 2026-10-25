// 脱链长任务：为什么存在、什么必须为真。
// 真事故（2026-10-25）：45 秒影片渲染启动后被 `sc stop` 连带杀死（run 记录 error=server_restarted），
// 而小语为等它 sleep 90/120，把单轮执行预算等光。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCmdFile, readLogTail, parseDone, launchDetached, readDetached, stopDetached, listDetached,
  DONE_MARK, DETACHED_DIR, isAsciiPath, pickBaseDir,
} from "../../engine/detached-run.mjs";

function tmpWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "detached-"));
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  return root;
}

test("启动脚本：切目录、追加到日志、末尾写完成标记与退出码", () => {
  const cmd = buildCmdFile({ command: "node render.js --workers 4", cwd: "D:/work", logPath: "D:/work/out.log" });
  assert.match(cmd, /@echo off/);
  assert.match(cmd, /cd \/d "D:\/work"/, "必须先切到工作目录，否则相对路径全错");
  assert.match(cmd, /node render\.js --workers 4 >> "D:\/work\/out\.log" 2>&1/);
  assert.match(cmd, new RegExp(`${DONE_MARK} %ERRORLEVEL%`), "要有完成标记，status 靠它判结束");
  assert.ok(cmd.includes("\r\n"), "Windows 批处理要 CRLF");
});

test("完成标记解析：有则给退出码，没有就是还在跑", () => {  assert.deepEqual(parseDone("rendering...\n"), { done: false, exitCode: null });
  assert.deepEqual(parseDone(`foo\n${DONE_MARK} 0\n`), { done: true, exitCode: 0 });
  assert.deepEqual(parseDone(`${DONE_MARK} 1`), { done: true, exitCode: 1 });
  assert.deepEqual(parseDone(`${DONE_MARK} 3221225786`), { done: true, exitCode: 3221225786 });
});

test("日志尾巴只读末尾，不整份进内存（渲染日志会到几 MB）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  const file = path.join(dir, "big.log");
  fs.writeFileSync(file, "A".repeat(50_000) + "TAIL-MARKER\n", "utf8");
  const tail = readLogTail(file, { bytes: 100 });
  assert.ok(tail.length <= 100);
  assert.match(tail, /TAIL-MARKER/);
  assert.equal(readLogTail(path.join(dir, "nope.log")), "", "读不到不抛错");
});

test("没有元数据就报查不到（不是假装成功）", () => {
  const ws = tmpWs();
  const r = readDetached({ wsRoot: ws, id: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到/);
});

test("真起一个脱链进程：能启动、能查到、跑完有退出码、且不在本进程树里", async () => {
  const ws = tmpWs();
  // 用一个短命的 node 命令，输出一行再睡 1 秒（足够我们查到"还在跑"）
  const out = launchDetached({ wsRoot: ws, command: `node -e "console.log('hello-detached'); setTimeout(()=>{},1200)"`, label: "smoke" });
  assert.equal(out.ok, true, out.error || "");
  assert.ok(out.pid > 0, "应该拿到 pid");
  assert.ok(fs.existsSync(path.join(ws, DETACHED_DIR)), "作业目录要落盘");

  const first = readDetached({ wsRoot: ws, id: out.id });
  assert.equal(first.ok, true);
  assert.equal(first.label, "smoke");
  assert.equal(first.done, false, "刚启动不该是完成");
  assert.equal(first.alive, true, "应该还活着");

  // 等它跑完（最多 15 秒），期间不 sleep 在单轮里干等——这里只是测试
  let last = first;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    last = readDetached({ wsRoot: ws, id: out.id });
    if (last.done) break;
  }
  assert.equal(last.done, true, "应该写出完成标记");
  assert.equal(last.exitCode, 0, `退出码应为 0，实际 ${last.exitCode}；日志：${last.logTail}`);
  assert.match(last.logTail, /hello-detached/, "日志要收到命令输出");
});

test("list 能列出作业；stop 对已结束的作业是幂等的", async () => {
  const ws = tmpWs();
  const out = launchDetached({ wsRoot: ws, command: `node -e "setTimeout(()=>{},800)"`, label: "list-me" });
  assert.equal(out.ok, true, out.error || "");
  const rows = listDetached({ wsRoot: ws, limit: 5 });
  assert.ok(rows.some((r) => r.id === out.id));
  const stopped = stopDetached({ wsRoot: ws, id: out.id });
  assert.equal(stopped.ok, true);
});

test("作业目录必须是 ASCII：中文工作区回落到 ProgramData，选不到就如实拒绝", () => {
  assert.equal(isAsciiPath("D:\\pi-workspace"), true);
  assert.equal(isAsciiPath("D:\\工作区"), false, "中文路径会让 cmd.exe /c 找不到 .cmd（实测）");
  assert.equal(pickBaseDir("D:\\pi-workspace"), path.join("D:\\pi-workspace", DETACHED_DIR));

  const fallback = pickBaseDir("D:\\中文\\工作区");
  assert.ok(fallback === "" || isAsciiPath(fallback), `回落目录也必须是 ASCII，实际：${fallback}`);

  const rejected = launchDetached({ wsRoot: "D:\\中文\\工作区", command: "echo hi" });
  // ProgramData 通常是 ASCII，所以这里多半能启动；关键是：**绝不能返回一个中文路径的作业目录**
  if (!rejected.ok) assert.match(rejected.error, /ASCII|找不到/);
  else assert.ok(isAsciiPath(rejected.logPath), `日志路径必须是 ASCII：${rejected.logPath}`);
});
