// 钉死：.cmd 不能带 BOM（真机事故），且必须能真跑出日志
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCmdFile, assertCmdSafe, launchDetached, readDetached, pickBaseDir } from "../../engine/detached-run.mjs";

test(".cmd 首字符不能是 UTF-8 BOM（cmd.exe 会把 BOM 当首行命令，整份脚本不执行）", () => {
  const text = buildCmdFile({ command: 'node -e "console.log(1)"', cwd: "D:/pi-web", logPath: "C:/x.log" });
  assert.notEqual(text.charCodeAt(0), 0xFEFF);
  assert.equal(text.startsWith("@echo off"), true);
  assert.equal(text.includes("chcp 65001"), true);
});

test("assertCmdSafe：带 BOM 要拒绝；纯 ASCII 放行；含中文拒绝", () => {
  assert.equal(assertCmdSafe("\ufeff@echo off\r\n").ok, false);
  assert.match(assertCmdSafe("\ufeff@echo off\r\n").reason, /BOM/);
  assert.equal(assertCmdSafe('@echo off\r\ncd /d "D:\\pi-web"\r\nnode x.js >> "C:\\t.log" 2>&1\r\n').ok, true);
  assert.equal(assertCmdSafe('@echo off\r\ncd /d "D:\\工作区"\r\n').ok, false);
});

test("真起一个作业：.cmd 无 BOM、日志有输出、有完成标记", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "detached-bom-"));
  const out = launchDetached({ wsRoot: ws, command: 'node -e "console.log(777)"', cwd: "D:/pi-web", label: "bom-check" });
  assert.equal(out.ok, true, out.error || "");
  const cmdFile = path.join(pickBaseDir(ws), `${out.id}.cmd`);
  const raw = fs.readFileSync(cmdFile, "utf8");
  assert.notEqual(raw.charCodeAt(0), 0xFEFF, ".cmd 不能带 BOM");

  let st = readDetached({ wsRoot: ws, id: out.id });
  for (let i = 0; i < 20 && !st.done; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    st = readDetached({ wsRoot: ws, id: out.id });
  }
  assert.equal(st.done, true, "应该跑完");
  assert.match(String(st.logTail || ""), /777/, "日志里应该有输出");
});
