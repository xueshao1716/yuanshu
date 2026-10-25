// pwsh 工具：Windows 原生 PowerShell 通道（2026-10-25）。
// 起因：真机上 bash（git-bash）的路径/引号/编码和 Windows 不是一套，模型为同一种活
// 在两种语法间来回试，工具调用次数翻倍；DSH 有原生 pwsh 工具，这里对齐。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUnifiedToolExecutor, detectPwsh, pwshToolDescription, BASE_TOOL_SCHEMAS } from "../../engine/tools/unified-tools.mjs";

const isWin = process.platform === "win32";

test("schema 里同时有 bash 与 pwsh 两个通道", () => {
  const names = BASE_TOOL_SCHEMAS.map((s) => s?.function?.name);
  assert.ok(names.includes("bash"));
  assert.ok(names.includes("pwsh"), "Windows 上要有一条原生 PowerShell 通道");
});

test("PowerShell 探测：Windows 上给出现存路径（优先 7，退回 5.1）", () => {
  const exe = detectPwsh({ refresh: true });
  if (!isWin) { assert.equal(exe, null, "非 Windows 不该有 pwsh"); return; }
  assert.ok(exe, "本机至少要有 Windows PowerShell 5.1");
  if (exe !== "pwsh.exe") assert.ok(fs.existsSync(exe), `探测到的路径必须存在：${exe}`);
});

test("描述里说清它是谁、并且要求优先用它", () => {
  const d = pwshToolDescription();
  assert.match(d, /PowerShell/);
  if (isWin) assert.match(d, /优先用它/);
});

test("真跑一条：Get-Date 能出结果，退出码 0", async (t) => {
  if (!isWin) { t.skip("非 Windows"); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pwsh-"));
  const exec = createUnifiedToolExecutor({ cwd: () => tmp, safePath: (p) => path.resolve(tmp, p || "") });
  const out = await exec("pwsh", { command: "Get-Date -Format 'yyyy'" }, {});
  assert.equal(out.isError, false, `不该报错：${out.text?.slice(0, 200)}`);
  assert.match(String(out.text), /^\s*20\d\d\s*$/, `应输出四位年份，实际：${JSON.stringify(out.text)}`);
});

test("非零退出码要如实报出来，且标成失败", async (t) => {
  if (!isWin) { t.skip("非 Windows"); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pwsh2-"));
  const exec = createUnifiedToolExecutor({ cwd: () => tmp, safePath: (p) => path.resolve(tmp, p || "") });
  const out = await exec("pwsh", { command: "cmd /c exit 3" }, {});
  assert.equal(out.isError, true);
  assert.match(String(out.text), /退出码 3/, `要带退出码，实际：${String(out.text).slice(0, 160)}`);
});

test("中文输出不乱码（输出编码已强制 UTF-8）", async (t) => {
  if (!isWin) { t.skip("非 Windows"); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pwsh3-"));
  const exec = createUnifiedToolExecutor({ cwd: () => tmp, safePath: (p) => path.resolve(tmp, p || "") });
  const out = await exec("pwsh", { command: "Write-Output '中文输出测试'" }, {});
  assert.equal(out.isError, false);
  assert.match(String(out.text), /中文输出测试/, `中文被弄坏了：${String(out.text).slice(0, 120)}`);
});
