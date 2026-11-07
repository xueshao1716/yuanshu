// 进程树清理（第三条不足）：Windows 用 taskkill /T /F 杀整棵树，非 Windows 对 -pid 进程组发 SIGKILL；
// 超时与取消走同一条清理；真机上验证「父进程 + 孙进程」都被清掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { killProcessTree, probeCmd } from "../../engine/watch-duty.mjs";

function fakeChild(pid = 4321) {
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => true;
  return c;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

test("killProcessTree Windows：taskkill /PID <pid> /T /F，不碰 process.kill", () => {
  const calls = [];
  const child = fakeChild(4321);
  const r = killProcessTree(child, {
    platform: "win32",
    spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return new EventEmitter(); },
    killFn: () => { throw new Error("Windows 不该走 process.kill(-pid)"); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.method, "taskkill");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "taskkill");
  assert.deepEqual(calls[0].args, ["/PID", "4321", "/T", "/F"]);
  assert.equal(calls[0].opts.windowsHide, true);
});

test("killProcessTree 非 Windows：对进程组发 SIGKILL（-pid）", () => {
  const killed = [];
  const r = killProcessTree(fakeChild(4321), {
    platform: "linux",
    spawnFn: () => { throw new Error("非 Windows 不该 spawn taskkill"); },
    killFn: (pid, sig) => { killed.push([pid, sig]); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.method, "process-group");
  assert.deepEqual(killed, [[-4321, "SIGKILL"]]);
});

test("killProcessTree 没有 pid 时返回失败，不抛", () => {
  const r = killProcessTree({});
  assert.equal(r.ok, false);
  assert.equal(r.method, "none");
});

test("probeCmd 超时：走 taskkill /T /F，结果带 pid 与 timedOut", async () => {
  const spawns = [];
  const child = fakeChild(5555);
  const taskkill = new EventEmitter();
  // probeCmd 用 spawnFn(cmd, opts) 两参；killProcessTree 用 spawnFn("taskkill", args, opts) 三参
  const spawnFn = (cmd, a, b) => {
    const args = Array.isArray(a) ? a : [];
    const opts = Array.isArray(a) ? b : a;
    spawns.push({ cmd, args, opts });
    return cmd === "taskkill" ? taskkill : child;
  };
  const p = probeCmd(
    { command: "node hang.mjs", expectExit: 0, timeoutMs: 1000 },
    { wsRoot: process.cwd(), platform: "win32", spawnFn, killFn: () => {} },
  );
  child.stdout.emit("data", Buffer.from("partial output"));
  const r = await p;

  assert.equal(r.timedOut, true);
  assert.equal(r.pid, 5555);
  assert.match(r.stdout, /partial output/);
  assert.equal(spawns[0].opts.detached, false, "Windows 不需要 detached 进程组");
  const tk = spawns.find((s) => s.cmd === "taskkill");
  assert.ok(tk, "超时必须调 taskkill");
  assert.deepEqual(tk.args, ["/PID", "5555", "/T", "/F"]);
});

test("probeCmd 取消（AbortSignal）：与超时同一条清理；非 Windows 进程组 detached", async () => {
  const killed = [];
  const spawns = [];
  const child = fakeChild(6789);
  const spawnFn = (cmd, a, b) => {
    const args = Array.isArray(a) ? a : [];
    const opts = Array.isArray(a) ? b : a;
    spawns.push({ cmd, args, opts });
    return child;
  };
  const ac = new AbortController();
  const p = probeCmd(
    { command: "node hang.mjs", expectExit: 0, timeoutMs: 60_000 },
    { wsRoot: process.cwd(), platform: "linux", spawnFn, killFn: (pid, sig) => { killed.push([pid, sig]); }, signal: ac.signal },
  );
  setTimeout(() => ac.abort(), 20);
  const r = await p;

  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.pid, 6789);
  assert.equal(spawns[0].opts.detached, true, "非 Windows 要自成进程组");
  assert.deepEqual(killed, [[-6789, "SIGKILL"]]);
});

test("Windows 真机：超时 taskkill /T 连同孙进程一起清理", { skip: process.platform !== "win32" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-tree-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "tree.cjs");
  // 先落 pid 文件再打印：即使 stdout 没赶上超时，也能拿到父子 pid 断言
  fs.writeFileSync(script, [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const c = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });',
    'fs.writeFileSync(path.join(__dirname, "pids.json"), JSON.stringify({ self: process.pid, child: c.pid }));',
    'console.log("SELF:" + process.pid);',
    'console.log("CHILD:" + c.pid);',
    'setTimeout(() => {}, 30000);',
  ].join("\n"), "utf8");

  const r = await probeCmd(
    { command: `node "${script}"`, expectExit: 0, timeoutMs: 2000 },
    { wsRoot: dir },
  );
  assert.equal(r.timedOut, true, `命令应超时；stdout=${r.stdout}`);

  const pids = JSON.parse(fs.readFileSync(path.join(dir, "pids.json"), "utf8"));
  assert.ok(pids.self > 0 && pids.child > 0);

  // taskkill 是异步的：最多等 5 秒让进程真正消失
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (pidAlive(pids.self) || pidAlive(pids.child))) {
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(pidAlive(pids.child), false, "孙进程必须被 taskkill /T 清理");
  assert.equal(pidAlive(pids.self), false, "命令进程必须被清理");
});
