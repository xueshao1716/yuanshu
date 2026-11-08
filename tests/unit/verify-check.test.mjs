// ===== verify-check.test.mjs —— verify_check 工具与注册（2026-11-09）=====
//
// 三条线一起锁：
//   ① 工具本身：schema 能看见 8 种断言、上限 8 条、说明写清「报数之前用」与「静默」
//   ② 工具行为：走同一套闸门（越界拒、deny 拒、注入 run），汇总与 isError 一致
//   ③ 接线：UNIFIED_TOOLS 里有它、执行器表里有它、协议里有那条硬规则、tool-inits 有 SDK 版
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VERIFY_CHECK_TOOL, createVerifyCheckExecutor, executeVerifyCheck } from "../../engine/tools/verify-check.mjs";
import { YUANSHU_PROTOCOL } from "../../engine/yuanshu-protocol.mjs";
import { ASSERTION_TYPES, MAX_CLAIMS } from "../../engine/claim-verify.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

async function rmTempDir(dir, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (err) {
      const retriable = ["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(err?.code);
      if (!retriable || Date.now() - started > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-verify-check-"));
  fs.mkdirSync(path.join(root, "生成物", "图片"), { recursive: true });
  fs.writeFileSync(path.join(root, "生成物", "图片", "x.png"), Buffer.alloc(2048, 3));
  fs.writeFileSync(path.join(root, "报告.md"), "第一行\n第二行\n");
  return root;
}

test("schema：8 种断言、最多 8 条、描述写明「报数之前用」", () => {
  const fn = VERIFY_CHECK_TOOL.function;
  assert.equal(VERIFY_CHECK_TOOL.type, "function");
  assert.equal(fn.name, "verify_check");
  const claims = fn.parameters.properties.claims;
  assert.equal(claims.type, "array");
  assert.equal(claims.items.properties.kind.enum.length, 8);
  assert.deepEqual(claims.items.properties.kind.enum, ASSERTION_TYPES);
  assert.equal(claims.items.required.includes("kind"), true);
  assert.equal(claims.items.properties.op.enum.includes("=="), true);
  assert.equal(claims.items.properties.line.type, "number");
  assert.equal(fn.parameters.required.includes("claims"), true);
  assert.ok(claims.description.includes(String(MAX_CLAIMS)), "描述里要写清上限");

  // 描述决定它会不会被用：必须点名「报数之前」+「有一条 ❌ 就不许说完成」+「不推给用户」
  assert.match(fn.description, /报数之前/);
  assert.match(fn.description, /不许说完成|不许说完成/);
  assert.match(fn.description, /不会推给用户/);
  assert.match(fn.description, /最多 8 条/);
});

test("执行器：全过时 isError=false，并带汇总 details", async () => {
  const root = makeWorkspace();
  try {
    const run = createVerifyCheckExecutor({ cwd: root, roots: [root] });
    const out = await run({
      claims: [
        { kind: "EXISTS", target: "生成物/图片/x.png" },
        { kind: "COUNT", target: "生成物/图片", op: "==", expected: "1" },
        { kind: "SIZE_EQ", target: "生成物/图片/x.png", expected: 2048 },
        { kind: "CONTAINS", target: "报告.md", expected: "第二行" },
      ],
    });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /通过 4 · 未过 0/);
    assert.equal(out.details.total, 4);
    assert.equal(out.details.passed, 4);
    assert.equal(out.details.ok, true);
  } finally { await rmTempDir(root); }
});

test("执行器：有 FAIL 时 isError=true，文本给实际数字而不是只说「失败」", async () => {
  const root = makeWorkspace();
  try {
    const run = createVerifyCheckExecutor({ cwd: root, roots: [root] });
    const out = await run({
      claims: [
        { kind: "EXISTS", target: "生成物/图片/x.png" },
        { kind: "COUNT", target: "生成物/图片", op: "==", expected: 92 },
      ],
    });
    assert.equal(out.isError, true, "有一条 FAIL 就必须是失败结果");
    assert.match(out.text, /❌ COUNT 生成物\/图片 条目数 预期 92 实际 1/);
    assert.match(out.text, /别说完成/);
  } finally { await rmTempDir(root); }
});

test("执行器：越界路径 / deny 命令 / 非数组入参都被拒", async () => {
  const root = makeWorkspace();
  try {
    const run = createVerifyCheckExecutor({ cwd: root, roots: [root], run: async () => { throw new Error("不该被执行"); } });

    const out = await run({
      claims: [
        { kind: "EXISTS", target: "../逃出去.txt" },
        { kind: "COUNT", command: "ngrok http 8080", op: "==", expected: 1 },
      ],
    });
    assert.equal(out.isError, true);
    assert.equal(out.details.failed, 2);
    assert.match(out.text, /越界/);
    assert.match(out.text, /红线|危险命令/);

    const bad = await run({ claims: "EXISTS 生成物/图片/x.png" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /claims 数组/);

    const tooMany = await run({ claims: Array.from({ length: 9 }, () => ({ kind: "EXISTS", target: "生成物" })) });
    assert.equal(tooMany.isError, true);
    assert.match(tooMany.text, /上限 8 条/);
  } finally { await rmTempDir(root); }
});

test("执行器：命令类断言真的走注入的 run，cwd 是工作区", async () => {
  const root = makeWorkspace();
  try {
    const calls = [];
    const out = await executeVerifyCheck(
      { claims: [{ kind: "COUNT", command: "列出测试结果", op: "==", expected: 2 }] },
      { cwd: root, roots: [root], run: async (command, opts) => { calls.push({ command, opts }); return { ok: true, code: 0, stdout: "ok 1\nok 2\n", stderr: "" }; } },
    );
    assert.equal(out.isError, false, out.text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "列出测试结果");
    assert.equal(calls[0].opts.cwd, root);
  } finally { await rmTempDir(root); }
});

test("统一执行器：extraExecutors 里的 verify_check 能被正常派发", async () => {
  const root = makeWorkspace();
  try {
    const { createUnifiedToolExecutor } = await import("../../engine/tools/unified-tools.mjs");
    const { safeJoin } = await import("../../engine/tools/security.mjs");
    // 与 server.mjs 里那条注册同形：一行只接 args 的箭头函数
    const exec = createUnifiedToolExecutor({
      cwd: () => root,
      safePath: (p) => safeJoin(root, p),
      extraExecutors: { verify_check: (args) => executeVerifyCheck(args, { cwd: () => root, roots: () => [root] }) },
    });
    const r = await exec("verify_check", {
      claims: [
        { kind: "EXISTS", target: "生成物/图片/x.png" },
        { kind: "COUNT", target: "生成物/图片", op: ">=", expected: 1 },
      ],
    });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /通过 2 · 未过 0/);
  } finally { await rmTempDir(root); }
});

test("静默：工具模块不接任何推送通道（结果只回模型）", () => {
  const src = read("engine", "tools", "verify-check.mjs");
  assert.doesNotMatch(src, /from\s+["'][^"']*(notifier|notify-channel|outbound|wechat)/i,
    "verify_check 不许自己往聊天/微信推送");
  assert.doesNotMatch(src, /fetch\(|httpJsonFetch/, "闸门不该发请求");
});

test("接线：UNIFIED_TOOLS 与执行器表里都有 verify_check", () => {
  const src = read("server.mjs");

  const start = src.indexOf("const UNIFIED_TOOLS = [");
  assert.ok(start > 0, "找不到 UNIFIED_TOOLS");
  const end = src.indexOf("\n];", start);
  assert.ok(end > start, "找不到 UNIFIED_TOOLS 的收尾");
  const list = src.slice(start, end);
  assert.match(list, /^\s*VERIFY_CHECK_TOOL,\s*$/m, "verify_check 必须进 UNIFIED_TOOLS");

  const exStart = src.indexOf("const extraToolExecutors = {");
  assert.ok(exStart > 0, "找不到执行器表 extraToolExecutors");
  const exEnd = src.indexOf("\n};", exStart);
  const table = src.slice(exStart, exEnd);
  assert.match(table, /^\s*verify_check:\s*\(args\)\s*=>/m, "执行器表里必须有 verify_check");
  assert.match(table, /roots:\s*\(\)\s*=>\s*\[CONFIG\.cwd,\s*__dirname\]/, "允许根 = 工作区 + 系统本体（与读写双根同口径）");

  assert.match(src, /import\s*\{[^}]*VERIFY_CHECK_TOOL[^}]*\}\s*from\s*["']\.\/engine\/tools\/verify-check\.mjs["']/);
  // 声明必须早于 UNIFIED_TOOLS：那个数组是模块求值时立刻构造的
  assert.ok(src.indexOf("import { VERIFY_CHECK_TOOL") < start, "导入必须在 UNIFIED_TOOLS 之前");
});

test("协议里有那条硬规则（原文级）", () => {
  assert.match(YUANSHU_PROTOCOL, /报数之前先落断言/);
  assert.match(YUANSHU_PROTOCOL, /verify_check/);
  assert.match(YUANSHU_PROTOCOL, /数量、存在性、路径、大小、测试结果/);
  assert.match(YUANSHU_PROTOCOL, /有一条 FAIL 就不许说完成/);
  assert.match(YUANSHU_PROTOCOL, /不要凭印象报数/);
  // 验证是后台动作：协议里必须带静默那一条，否则她会把断言清单贴给用户
  assert.match(YUANSHU_PROTOCOL, /别把断言清单和原始输出贴给用户/);
});

test("Pi 通道：tool-inits 有 SDK 版工具定义，manager 已挂上", () => {
  const inits = read("engine", "session", "tool-inits.mjs");
  assert.match(inits, /async function initVerifyCheckTool\(\)/);
  assert.match(inits, /name:\s*["']verify_check["']/);
  // 适用场景写在描述里：「报数之前用」——这条是任务要求，不是措辞偏好
  assert.match(inits, /description:\s*"报数之前用/);
  assert.match(inits, /initVerifyCheckTool,/);

  const manager = read("engine", "session", "manager.mjs");
  assert.match(manager, /initVerifyCheckTool/);
  assert.match(manager, /customTools\.push\(verifyTool\)/);
});
