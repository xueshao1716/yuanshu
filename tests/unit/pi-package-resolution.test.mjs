// 引擎解析健壮性契约（2026-09-14）
// 事故：watchdog（计划任务启动，env 里没有 NPM_CONFIG_PREFIX）拉起 server.mjs 时，
// config.mjs 的全局包探测全部 miss → piPackage="" → pathToFileURL("") 解析成启动目录
// → "Directory import 'D:\pi-web' is not supported" 崩溃，且报错完全不指向真因。
// 这两条测试按仓库既有「源码契约」风格锁住修复，且不依赖本机是否装了该包。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSrc = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
const configSrc = fs.readFileSync(path.join(root, "config.mjs"), "utf8");
const dshSrc = fs.readFileSync(path.join(root, "engine", "dsh-tool.mjs"), "utf8");

test("server.mjs：piPackage 为空必须显式拦截，不得退化成目录导入崩溃", () => {
  assert.match(serverSrc, /if \(!CONFIG\.piPackage\)/, "缺少 piPackage 空值守卫");
  assert.match(
    serverSrc,
    /Cannot find module '@earendil-works\/pi-coding-agent'/,
    "错误信息要带环境错特征串，好让 watchdog 归类为环境类崩溃而不触发回滚"
  );
  assert.match(
    serverSrc,
    /npm i -g @earendil-works\/pi-coding-agent/,
    "必须给出可执行的修复指引，而不是只抛底层解析错误"
  );
});

test("config.mjs：必须有一条不依赖环境变量的全局根探测，且 npm root -g 固定 cwd", () => {
  assert.match(
    configSrc,
    /path\.dirname\(process\.execPath\), "node_modules"/,
    "缺少从 node.exe 推导的全局 node_modules 探测（NPM_CONFIG_PREFIX 缺失时会全 miss）"
  );
  assert.match(
    configSrc,
    /cwd: __dirname/,
    "npm root -g 未固定 cwd —— 无 prefix 时它会随调用方 cwd 漂移"
  );
});

test("dsh-tool：Pi SDK 缺失时跳过初始化，不把空路径交给 createRequire", () => {
  assert.match(dshSrc, /if \(!piPackage\)/, "缺少 Pi SDK 缺失守卫");
  assert.match(dshSrc, /跳过 dsh 工具初始化/, "缺失 SDK 时应留下明确且非致命的日志");
});
