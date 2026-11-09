// 装配分级的运行时接线契约（2026-11-10）
//
// 这一轮修的是 `node scripts/assembly.mjs` 判红的项：
//   · 定时任务双模式 —— auditJobs/planJob 只导出、没人调（implemented）
//   · 产出新鲜度     —— 只有 CLI 在跑，服务里没接线
//   · 5 个能力       —— 只有 prompt 注入 / 模型工具，外面查不到状态（integrated，无开关）
//
// 测试全是静态断言（按块切 server.mjs 源码），理由：
//   1. 不起服务：这些路由挂在 8787 上，测试里再起一个会和线上抢端口（Windows 不报 EADDRINUSE）；
//   2. 不碰真实工作区：静态断言不读 记忆/，跑测试不改任何人的现场。
// 判据偏保守：只认字面注册与调用，认不出运行时死分支——那是 assembly 文件头里写明的局限。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITIES } from "../../engine/assembly-specs.mjs";
import { VERIFY_CHECK_STATUS } from "../../engine/tools/verify-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const server = fs.readFileSync(path.join(ROOT, "server.mjs"), "utf8");

// 这一轮新增的只读路由：路径 → 装配清单里的能力 id
const READ_ONLY_ROUTES = [
  ["/api/scheduled/audit", "scheduled-dual"],
  ["/api/vitality", "vitality"],
  ["/api/relationship", "relationship"],
  ["/api/anti-patterns", "anti-patterns"],
  ["/api/lesson-replay", "lesson-replay"],
  ["/api/praise-ledger", "praise-ledger"],
  ["/api/tools/verify-check", "verify-check"],
];

// 只读路由的处理体里一个都不许出现的写操作（含"顺手记一笔"那种）：
// 写开关要人批准，本轮只做"看得见"。快照由循环里的 tick 函数写，路由不碰。
const WRITE_CALLS = [
  "writeJsonFile(", "writeFileSync(", "appendFileSync(", "atomicWriteJson(",
  "recordInteraction(", "recordViolation(", "markReplayed(", "saveLedger(",
  "recordBypass(", "setPauseGate(",
];

/** 取一条固定路由的注册块：从 `["GET", "<path>"` 到下一个路由行之前。 */
function routeBlock(routePath) {
  const start = server.indexOf(`["GET", "${routePath}"`);
  if (start < 0) return "";
  const rest = server.slice(start + 1);
  const next = /\n\s*\["(GET|POST|PUT|PATCH|DELETE)",/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** 取一个顶层函数声明（到下一行行首的 `}` 为止；函数体里没有行首 `}`）。 */
function functionBody(name) {
  const start = server.indexOf(`function ${name}(`);
  assert.ok(start > 0, `server.mjs 里找不到 function ${name}`);
  const end = server.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} 的函数体没闭合`);
  return server.slice(start, end + 2);
}

/** 10 分钟循环那一段：setInterval 到 withJitter 收尾。 */
function tenMinuteLoop() {
  const end = server.indexOf("withJitter(10 * 60 * 1000");
  assert.ok(end > 0, "找不到 10 分钟定时器的 withJitter 收尾");
  const start = server.lastIndexOf("setInterval(() => {", end);
  assert.ok(start > 0 && start < end, "找不到 10 分钟定时器的开头");
  return server.slice(start, end);
}

test("新增的 7 个只读路由：都注册成 GET，且没有同名写入口", () => {
  for (const [routePath] of READ_ONLY_ROUTES) {
    assert.ok(server.includes(`["GET", "${routePath}"`), `${routePath} 应该注册成 GET`);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.ok(!server.includes(`["${method}", "${routePath}"`), `${routePath} 不该有 ${method} 写入口`);
    }
  }
});

test("只读性：这 7 条路由的处理体里没有任何写操作，也不触发写快照的 tick", () => {
  for (const [routePath] of READ_ONLY_ROUTES) {
    const block = routeBlock(routePath);
    assert.ok(block.length > 200, `${routePath} 的处理体没切出来（路由可能没注册）`);
    for (const call of WRITE_CALLS) {
      assert.ok(!block.includes(call), `${routePath} 是只读路由，却调了 ${call}`);
    }
    // 快照由 10 分钟循环写；路由只读，不许反过来触发写盘
    assert.ok(!block.includes("runScheduledAuditTick("), `${routePath} 不该调用写快照的 runScheduledAuditTick`);
    assert.ok(!block.includes("runVitalityAuditTick("), `${routePath} 不该调用写快照的 runVitalityAuditTick`);
  }
});

test("这 7 项在装配清单里都登记了对应路由开关（否则仍然只是 integrated）", () => {
  const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));
  for (const [routePath, id] of READ_ONLY_ROUTES) {
    const spec = byId.get(id);
    assert.ok(spec, `engine/assembly-specs.mjs 缺 ${id}`);
    const routes = (spec.switches || []).filter((s) => s && s.kind === "route").map((s) => s.path);
    assert.ok(routes.includes(routePath), `${id} 的 switches 里应有路由 ${routePath}`);
    assert.ok(server.includes(`"${routePath}"`), `${routePath} 得真的注册在 server.mjs`);
    assert.ok(!(spec.switches || []).some((s) => s && (s.kind === "env" || s.kind === "config")),
      `${id} 本轮只加只读路由，不该冒出可写开关`);
  }
});

test("10 分钟循环里真的调了定时任务审计与新鲜度体检（不是只定义没挂）", () => {
  const loop = tenMinuteLoop();
  assert.match(loop, /runScheduledAuditTick\(\);/, "循环里没调定时任务审计");
  assert.match(loop, /runVitalityAuditTick\(\);/, "循环里没调新鲜度体检（低频闸在 tick 内部）");
  // 两件都只读、出问题不阻塞循环
  assert.match(loop, /try \{ runScheduledAuditTick\(\); \} catch/);
  assert.match(loop, /try \{ runVitalityAuditTick\(\); \} catch/);
});

test("定时任务审计：tick → auditJobs/planJob，落 定时任务审计.json，分类漂移才打一行日志", () => {
  const tick = functionBody("runScheduledAuditTick");
  const snapshot = functionBody("scheduledAuditSnapshot");
  // 审计与计划都真调，且两步计划进快照
  assert.match(snapshot, /auditJobs\(\)/);
  assert.match(snapshot, /planJob\(/);
  assert.match(snapshot, /steps/);
  // 循环里只读：不执行任何作业
  assert.ok(!/recordJobRun|execFile|execSync|spawn\(|runJob\(/.test(snapshot), "审计快照不该执行作业");
  assert.ok(!/recordJobRun|execFile|execSync|spawn\(|runJob\(/.test(tick), "审计 tick 不该执行作业");
  assert.match(tick, /scheduledAuditSnapshot\(/);
  // 落盘路径是 记忆/运行时/定时任务审计.json（常量定义在 tick 旁边）
  assert.match(server, /SCHEDULED_AUDIT_REL = path\.join\("记忆", "运行时", "定时任务审计\.json"\)/);
  assert.match(tick, /SCHEDULED_AUDIT_REL/);
  assert.match(tick, /lastScheduledKinds/);
  // 连续两拍分类不一致才 log：日志写在 drift.length 判断里面
  assert.match(tick, /if \(drift\.length\) \{[\s\S]*console\.log\(/);
});

test("新鲜度体检：tick → auditVitality，6 小时一次，落 体检.json，有红项才打日志", () => {
  assert.match(server, /const VITALITY_EVERY_MS = 6 \* 60 \* 60 \* 1000;/, "体检必须是低频（6 小时）");
  const tick = functionBody("runVitalityAuditTick");
  assert.match(tick, /auditVitality\(\{ wsRoot: WS_ROOT/, "体检没真调 auditVitality");
  assert.match(tick, /summarizeVitality\(/);
  assert.match(tick, /lastVitalityAt/);
  assert.match(tick, /VITALITY_EVERY_MS/);
  assert.match(server, /VITALITY_AUDIT_REL = path\.join\("记忆", "运行时", "体检\.json"\)/);
  assert.match(tick, /VITALITY_AUDIT_REL/);
  // 只打日志：不推送、不调通知
  assert.match(tick, /needsAttention > 0[\s\S]*console\.log\(/);
  assert.ok(!/notifier\.|notify\(|toWechat|sendOut\(/.test(tick), "体检不该推送/打扰");
});

test("verify_check 的只读状态来自模块常量（不另编一份口径）", () => {
  assert.equal(VERIFY_CHECK_STATUS.name, "verify_check");
  assert.equal(VERIFY_CHECK_STATUS.alwaysOn, true);
  assert.equal(VERIFY_CHECK_STATUS.persistsResults, false, "结果不落盘，别假装有历史条目");
  assert.equal(VERIFY_CHECK_STATUS.maxClaims, 8);
  assert.ok(VERIFY_CHECK_STATUS.assertionTypes.includes("EXISTS"));
  assert.ok(VERIFY_CHECK_STATUS.countOps.includes("=="));
  const block = routeBlock("/api/tools/verify-check");
  assert.match(block, /\.\.\.VERIFY_CHECK_STATUS/, "路由应直接展开模块常量");
});

test("定时任务审计的路由与循环用同一份快照（不会各算一套）", () => {
  const block = routeBlock("/api/scheduled/audit");
  assert.match(block, /scheduledAuditSnapshot\(\)/);
  const tick = functionBody("runScheduledAuditTick");
  assert.match(tick, /scheduledAuditSnapshot\(/);
});
