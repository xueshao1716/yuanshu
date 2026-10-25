// 重启脚本的安全边界：只杀"确实是元枢 server.mjs"的残留，别人家的进程一个都不碰。
// 真事故背景：2026-10-25 19:32 旧实例占着 8787，新实例空转 60s 被当僵死重拉，循环约 10 分钟。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../../scripts/release-restart.mjs", import.meta.url), "utf8");

test("等端口释放，而不是停完就起", () => {
  assert.match(src, /waitPortFree\(/, "必须等端口真的空闲");
  assert.match(src, /STOPPED/i, "要确认服务确实停了");
});

test("残留实例只认元枢的 server.mjs，别的进程不杀", () => {
  assert.match(src, /function ours\(/, "要有归属判断");
  assert.match(src, /server\\\.mjs/i, "判断依据是命令行里的 server.mjs");
  // taskkill 必须出现在 ours() 判断之后
  const guard = src.indexOf("if (!ours(info))");
  const kill = src.indexOf("taskkill.exe");
  assert.ok(guard > 0 && kill > guard, "taskkill 必须在归属判断之后，不能无条件杀");
});

test("端口被非本程序的进程占着时，宁可拒绝启动也不乱杀", () => {
  assert.match(src, /拒绝启动/, "拿不到归属就退出，避免又进循环");
});

test("两个逃生开关都在：只报告不杀 / 服务已停时跳门禁", () => {
  assert.match(src, /--keep-stray/);
  assert.match(src, /--skip-gate/);
});

test("起来以后要验 health，不是看进程在不在", () => {
  assert.match(src, /waitHealth\(/, "health 才是可用性证据");
  assert.match(src, /api\/health/);
});
