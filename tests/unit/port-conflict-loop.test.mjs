// 端口冲突：被别的实例占着时必须以 78 退出，且看门狗要退避而不是当崩溃重拉。
// 真事故：2026-10-25 19:32 旧 pid 18560 占着 8787，新实例空转 60s 后失败退出，
// 看门狗当僵死重拉，循环约 10 分钟（用户看到的"服务又重启了"）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../../server.mjs", import.meta.url), "utf8");
const watchdog = fs.readFileSync(new URL("../../watchdog.cjs", import.meta.url), "utf8");

test("server：端口被占用时用专用退出码 78，不再空转 30 次", () => {
  assert.match(server, /process\.exit\(78\)/, "端口冲突要能明确表达，别混进 exit(1) 的崩溃语义");
  assert.match(server, /describePortOwner/, "报错时要能说清是谁占着端口");
});

test("watchdog：识别 78 → 退避，不当崩溃、不自动回滚", () => {
  assert.match(watchdog, /if \(code === 78\)/);
  assert.match(watchdog, /portConflictUntil/);
  // 退避窗口内必须先返回，不能被后面的防风暴/回滚分支吃掉
  const skip = watchdog.indexOf("if (portConflictUntil && now < portConflictUntil)");
  assert.ok(skip > 0, "拉起前必须先检查退避窗口");
  assert.ok(skip < watchdog.indexOf("if (now - lastRestartAt < 10000)"), "退避检查要在防风暴之前");
});

test("两条路径都保留了「不替用户杀进程」的边界", () => {
  assert.doesNotMatch(server, /taskkill[^\n]*describePortOwner/, "探查端口归属不许顺手杀进程");
  assert.match(server, /只读探查/, "要写明这是只读探查");
});
