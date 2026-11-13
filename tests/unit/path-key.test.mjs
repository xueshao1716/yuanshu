// tests/unit/path-key.test.mjs —— 路径归一化键（优点二）
// pi 1.5 的坑：c:\Users\me 与 C:\Users\me 被当成两个目录 → 技能重复加载、/resume 看不到会话。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathKey } from "../../engine/path-key.mjs";

test("Windows：大小写 + 斜杠 + 尾斜杠不同，但其实是同一条路径 → 同一个键", () => {
  assert.equal(pathKey("C:\\A\\b", "win32"), pathKey("c:/a/b/", "win32"));
});

test("Windows：归一结果固定为小写正斜杠、无尾斜杠", () => {
  assert.equal(pathKey("C:\\A\\B\\", "win32"), "c:/a/b");
  assert.equal(pathKey("D:\\pi-workspace", "win32"), "d:/pi-workspace");
});

test("不同路径绝不相等（不能归一过头）", () => {
  const base = pathKey("C:\\A\\b", "win32");
  assert.notEqual(base, pathKey("C:\\A\\c", "win32"));
  assert.notEqual(base, pathKey("C:\\A", "win32"));
  assert.notEqual(base, pathKey("D:\\A\\b", "win32"));
});

test("其它平台原样返回（POSIX 大小写敏感，动了就是新 bug）", () => {
  assert.equal(pathKey("/Users/Me/Work/", "linux"), "/Users/Me/Work/");
  assert.equal(pathKey("C:\\A\\b", "darwin"), "C:\\A\\b");
});

test("空值安全；默认平台与显式 win32 判定一致", () => {
  assert.equal(pathKey(null), "");
  assert.equal(pathKey(undefined), "");
  assert.equal(pathKey(""), "");
  if (process.platform === "win32") assert.equal(pathKey("C:\\A\\b"), pathKey("c:/a/b/"));
  else assert.equal(pathKey("C:\\A\\b"), "C:\\A\\b");
});

test("生产代码真的用上了：会话压缩互斥改走 pathKey（不是死模块）", () => {
  const src = fs.readFileSync(new URL("../../engine/session/manager.mjs", import.meta.url), "utf8");
  assert.match(src, /const sessionKey = pathKey\(file\)/);
  assert.match(src, /compactingSessions\.has\(sessionKey\)/);
  assert.match(src, /compactingSessions\.add\(sessionKey\)/);
  assert.match(src, /compactingSessions\.delete\(sessionKey\)/);
});
