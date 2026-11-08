// ===== claim-verify.test.mjs —— 断言闸门核心（2026-11-09）=====
//
// 这一层是「话里的数字和事实」的唯一硬判据，所以测试必须只碰临时目录与注入的 run：
// 不真的跑危险命令、不读真实工作产物（AGENTS.md：别拿真实产物当测试靶子）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runClaims, formatClaimReport, formatClaimLine, resolveClaimPath, assertCommandAllowed,
  defaultRun, isInsideRoot, ASSERTION_TYPES, MAX_CLAIMS,
} from "../../engine/claim-verify.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// Windows：刚被 kill 的进程会攥着 cwd 几百毫秒，期间 rmSync 报 EPERM。
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

/** 造一个临时工作区：生成物/图片 两张图（2048B / 10B）、一份两行文本、一个空目录。 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-claim-"));
  fs.mkdirSync(path.join(root, "生成物", "图片"), { recursive: true });
  fs.writeFileSync(path.join(root, "生成物", "图片", "a.png"), Buffer.alloc(2048, 7));
  fs.writeFileSync(path.join(root, "生成物", "图片", "b.png"), Buffer.alloc(10, 7));
  fs.writeFileSync(path.join(root, "笔记.md"), "第一行\ncode-triad 在这里\n第三行\n");
  fs.mkdirSync(path.join(root, "空目录"));
  return root;
}

/** 假执行器：记下被调用的命令，返回固定输出。 */
function fakeRun(output, { calls = [] } = {}) {
  return async (command, opts) => {
    calls.push({ command, opts });
    return { ok: true, code: 0, stdout: output, stderr: "" };
  };
}

async function one(claim, opts) {
  const s = await runClaims([claim], opts);
  return { summary: s, result: s.results[0] };
}

test("EXISTS：在 / 不在（相对路径、绝对路径都行）", async () => {
  const root = makeWorkspace();
  try {
    const okRel = await one({ kind: "EXISTS", target: "生成物/图片/a.png" }, { roots: [root] });
    assert.equal(okRel.result.ok, true, okRel.result.detail);
    assert.equal(okRel.result.type, "EXISTS");
    assert.equal(okRel.result.actual, "存在");

    const okAbs = await one({ kind: "EXISTS", target: path.join(root, "笔记.md") }, { roots: [root] });
    assert.equal(okAbs.result.ok, true, "绝对路径落在允许根内要放行");

    const missing = await one({ kind: "EXISTS", target: "生成物/图片/nope.png" }, { roots: [root] });
    assert.equal(missing.result.ok, false);
    assert.equal(missing.result.actual, "不存在");
    assert.match(missing.result.detail, /nope\.png/);
  } finally { await rmTempDir(root); }
});

test("NOT_EXISTS：确实不在才算过，存在就是 FAIL", async () => {
  const root = makeWorkspace();
  try {
    const ok = await one({ kind: "NOT_EXISTS", target: "生成物/图片/nope.png" }, { roots: [root] });
    assert.equal(ok.result.ok, true);
    assert.equal(ok.result.type, "NOT_EXISTS");

    const bad = await one({ kind: "NOT_EXISTS", target: "生成物/图片/a.png" }, { roots: [root] });
    assert.equal(bad.result.ok, false, "文件明明在，NOT_EXISTS 必须 FAIL");
    assert.equal(bad.result.actual, "存在");
  } finally { await rmTempDir(root); }
});

test("COUNT：目录条目数 / 文件行数 / 命令输出行数 / 匹配数", async () => {
  const root = makeWorkspace();
  try {
    // 目录条目
    const dir = await one({ kind: "COUNT", target: "生成物/图片", op: "==", expected: 2 }, { roots: [root] });
    assert.equal(dir.result.ok, true, dir.result.detail);
    assert.equal(dir.result.actual, 2);
    assert.equal(dir.result.noun, "条目数");

    const dirBad = await one({ kind: "COUNT", target: "生成物/图片", op: "==", expected: 92 }, { roots: [root] });
    assert.equal(dirBad.result.ok, false);
    assert.equal(dirBad.result.actual, 2);

    // 目录 + 文件名过滤
    const dirMatch = await one({ kind: "COUNT", target: "生成物/图片", op: "==", expected: 1, match: "b." }, { roots: [root] });
    assert.equal(dirMatch.result.ok, true, dirMatch.result.detail);

    // 文件行数
    const lines = await one({ kind: "COUNT", target: "笔记.md", op: "==", expected: 3 }, { roots: [root] });
    assert.equal(lines.result.ok, true, lines.result.detail);
    assert.equal(lines.result.noun, "行数");

    // 文件里某段文字出现几次
    const match = await one({ kind: "COUNT", target: "笔记.md", op: "==", expected: 1, match: "code-triad" }, { roots: [root] });
    assert.equal(match.result.ok, true, match.result.detail);
    assert.equal(match.result.noun, "匹配数");

    // 命令输出行数（注入 run，不真跑）
    const calls = [];
    const cmd = await one({ kind: "COUNT", command: "列出某目录", op: "==", expected: 3 }, { roots: [root], run: fakeRun("a\nb\nc", { calls }) });
    assert.equal(cmd.result.ok, true, cmd.result.detail);
    assert.equal(cmd.result.noun, "行数");
    assert.equal(calls.length, 1, "命令类断言必须走注入的 run");
    assert.equal(calls[0].opts.cwd, root, "命令要在工作区目录里跑");

    // 操作符：大于 / 小于 / 不等于
    for (const [op, expected, want] of [[">", 2, true], ["<", 2, false], ["!=", 3, false], [">=", 3, true]]) {
      const r = await one({ kind: "COUNT", command: "x", op, expected }, { roots: [root], run: fakeRun("a\nb\nc") });
      assert.equal(r.result.ok, want, `${op} ${expected} → ${want}（${r.result.detail}）`);
    }

    // 非法操作符 / 非数字期望值：FAIL 而不是抛异常
    const badOp = await one({ kind: "COUNT", command: "x", op: "~", expected: 3 }, { roots: [root], run: fakeRun("a") });
    assert.equal(badOp.result.ok, false);
    assert.match(badOp.result.detail, /未知操作符/);
    const badNum = await one({ kind: "COUNT", command: "x", op: "==", expected: "九十二" }, { roots: [root], run: fakeRun("a") });
    assert.equal(badNum.result.ok, false);
    assert.match(badNum.result.detail, /不是数字/);
  } finally { await rmTempDir(root); }
});

test("CONTAINS：文件里 / 命令输出里有没有这段文字", async () => {
  const root = makeWorkspace();
  try {
    const ok = await one({ kind: "CONTAINS", target: "笔记.md", expected: "code-triad" }, { roots: [root] });
    assert.equal(ok.result.ok, true, ok.result.detail);

    const no = await one({ kind: "CONTAINS", target: "笔记.md", expected: "根本没有这句" }, { roots: [root] });
    assert.equal(no.result.ok, false);
    assert.equal(no.result.actual, "未找到");

    // 命令输出（stderr 也算：出错信息里也可能有要找的字）
    const viaCmd = await one({ kind: "CONTAINS", command: "跑一条命令", expected: "boom" }, {
      roots: [root], run: async () => ({ ok: false, code: 1, stdout: "", stderr: "boom: 炸了" }),
    });
    assert.equal(viaCmd.result.ok, true, viaCmd.result.detail);

    const missingNeedle = await one({ kind: "CONTAINS", target: "笔记.md" }, { roots: [root] });
    assert.equal(missingNeedle.result.ok, false);
    assert.match(missingNeedle.result.detail, /需要 expected/);
  } finally { await rmTempDir(root); }
});

test("LINE_EQ / LINE_INCLUDES：第 N 行等于 / 包含", async () => {
  const root = makeWorkspace();
  try {
    const eqOk = await one({ kind: "LINE_EQ", target: "笔记.md", line: 2, expected: "code-triad 在这里" }, { roots: [root] });
    assert.equal(eqOk.result.ok, true, eqOk.result.detail);

    const eqBad = await one({ kind: "LINE_EQ", target: "笔记.md", line: 2, expected: "code-triad" }, { roots: [root] });
    assert.equal(eqBad.result.ok, false, "整行相等不是包含，半截不算过");
    assert.equal(eqBad.result.actual, "code-triad 在这里");

    const incOk = await one({ kind: "LINE_INCLUDES", target: "笔记.md", line: 2, expected: "code-triad" }, { roots: [root] });
    assert.equal(incOk.result.ok, true, incOk.result.detail);

    const incBad = await one({ kind: "LINE_INCLUDES", target: "笔记.md", line: 1, expected: "code-triad" }, { roots: [root] });
    assert.equal(incBad.result.ok, false);

    const outOfRange = await one({ kind: "LINE_EQ", target: "笔记.md", line: 99, expected: "x" }, { roots: [root] });
    assert.equal(outOfRange.result.ok, false);
    assert.match(outOfRange.result.detail, /第 99 行不存在/);

    const noLine = await one({ kind: "LINE_EQ", target: "笔记.md", expected: "x" }, { roots: [root] });
    assert.equal(noLine.result.ok, false);
    assert.match(noLine.result.detail, /需要 line/);

    // 命令输出的行号
    const viaCmd = await one({ kind: "LINE_EQ", command: "列出行", line: 2, expected: "b" }, {
      roots: [root], run: fakeRun("a\nb\nc\n"),
    });
    assert.equal(viaCmd.result.ok, true, viaCmd.result.detail);
  } finally { await rmTempDir(root); }
});

test("SIZE_GT / SIZE_EQ：按字节数比，目录要如实判失败", async () => {
  const root = makeWorkspace();
  try {
    const gt = await one({ kind: "SIZE_GT", target: "生成物/图片/a.png", expected: 1024 }, { roots: [root] });
    assert.equal(gt.result.ok, true, gt.result.detail);
    assert.equal(gt.result.actual, 2048);

    const gtBad = await one({ kind: "SIZE_GT", target: "生成物/图片/b.png", expected: 1024 }, { roots: [root] });
    assert.equal(gtBad.result.ok, false);
    assert.equal(gtBad.result.actual, 10);

    const eq = await one({ kind: "SIZE_EQ", target: "生成物/图片/b.png", expected: 10 }, { roots: [root] });
    assert.equal(eq.result.ok, true, eq.result.detail);

    const eqBad = await one({ kind: "SIZE_EQ", target: "生成物/图片/b.png", expected: 2048 }, { roots: [root] });
    assert.equal(eqBad.result.ok, false);

    const dir = await one({ kind: "SIZE_EQ", target: "生成物/图片", expected: 1 }, { roots: [root] });
    assert.equal(dir.result.ok, false);
    assert.match(dir.result.detail, /目录/);

    const missing = await one({ kind: "SIZE_GT", target: "没有这个文件.bin", expected: 1 }, { roots: [root] });
    assert.equal(missing.result.ok, false);
    assert.equal(missing.result.actual, "不存在");
  } finally { await rmTempDir(root); }
});

test("越界路径被拒：../、根外绝对路径、符号链接逃逸", async () => {
  const root = makeWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-claim-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside");

    const rel = await one({ kind: "EXISTS", target: "../outside/outside.txt" }, { roots: [root] });
    assert.equal(rel.result.ok, false);
    assert.match(rel.result.detail, /越界/);

    const abs = await one({ kind: "EXISTS", target: path.join(outside, "outside.txt") }, { roots: [root] });
    assert.equal(abs.result.ok, false, "根外绝对路径必须拒，不能因为它在磁盘上就放行");
    assert.match(abs.result.detail, /越界/);

    // 绝对路径：别的盘/系统目录也不行
    const sys = await one({ kind: "EXISTS", target: process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hosts" }, { roots: [root] });
    assert.equal(sys.result.ok, false);
    assert.match(sys.result.detail, /越界/);

    // 符号链接 / junction 逃逸：解析真实路径后仍要落在根内
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(root, "逃逸"), process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch { /* 没权限建链接就跳过这一段（其余用例已经覆盖越界） */ }
    if (linked) {
      const escape = await one({ kind: "EXISTS", target: "逃逸/outside.txt" }, { roots: [root] });
      assert.equal(escape.result.ok, false, "符号链接跑出允许根必须拒");
      const resolved = resolveClaimPath("逃逸/outside.txt", { roots: [root] });
      assert.equal(resolved.ok, false);
    }

    // 没有根时一律拒绝（fail-closed）
    const noRoot = await one({ kind: "EXISTS", target: "笔记.md" }, { roots: [] });
    assert.equal(noRoot.result.ok, false);
    assert.match(noRoot.result.detail, /没有可用的允许根/);
  } finally {
    await rmTempDir(root);
    await rmTempDir(outside);
  }
});

test("deny 命令被拒：宪法红线与危险命令都不许跑", async () => {
  const root = makeWorkspace();
  try {
    for (const command of ["ngrok http 8080", "cloudflared tunnel run", "git push -f origin main"]) {
      const guard = assertCommandAllowed(command);
      assert.equal(guard.ok, false, `${command} 必须被红线拦住`);
      const r = await one({ kind: "COUNT", command, op: "==", expected: 1 }, { roots: [root], run: async () => { throw new Error("不该被执行"); } });
      assert.equal(r.result.ok, false);
      assert.match(r.result.detail, /红线|危险命令/);
    }
    const rm = await one({ kind: "COUNT", command: "rm -rf /", op: "==", expected: 0 }, { roots: [root], run: async () => { throw new Error("不该被执行"); } });
    assert.equal(rm.result.ok, false);
    assert.match(rm.result.detail, /危险命令/);

    // 默认执行器自己也要拦（注入不了 run 的路径不能成缺口）
    const box = await defaultRun("ngrok http 8080", { cwd: root, timeoutMs: 5000 });
    assert.equal(box.denied, true);
    assert.equal(box.rule, "no-tunnel");

    // 无害命令照常能跑
    const echo = await defaultRun("echo verify-gate-ok", { cwd: root, timeoutMs: 8000 });
    assert.equal(echo.ok, true, echo.error || echo.stderr);
    assert.match(echo.stdout, /verify-gate-ok/);

    // 空命令算失败，不当成"0 行"
    const empty = await one({ kind: "COUNT", command: "   ", op: "==", expected: 0 }, { roots: [root] });
    assert.equal(empty.result.ok, false);
    assert.match(empty.result.detail, /空命令/);
  } finally { await rmTempDir(root); }
});

test("超过 8 条被拒；空断言被拒；未知断言判 FAIL 而不是崩", async () => {
  const root = makeWorkspace();
  try {
    const okClaims = Array.from({ length: MAX_CLAIMS }, () => ({ kind: "EXISTS", target: "笔记.md" }));
    const eight = await runClaims(okClaims, { roots: [root] });
    assert.equal(eight.total, 8, "上限 8 条本身要能跑");
    assert.equal(eight.ok, true);

    const nine = await runClaims([...okClaims, { kind: "EXISTS", target: "笔记.md" }], { roots: [root] });
    assert.equal(nine.ok, false);
    assert.equal(nine.rejected, true);
    assert.match(nine.error, /上限 8 条/);
    assert.equal(nine.total, 9, "被拒的也要如实报条数");
    assert.equal(nine.passed, 0);

    const zero = await runClaims([], { roots: [root] });
    assert.equal(zero.ok, false);
    assert.equal(zero.rejected, true);
    assert.match(zero.error, /至少要一条/);

    const weird = await one({ kind: "TELEPATHY", target: "笔记.md" }, { roots: [root] });
    assert.equal(weird.result.ok, false);
    assert.match(weird.result.detail, /未知断言/);

    // XCTAssert 这种大小写/空格写法要能归一
    const loose = await one({ kind: " exists ", target: "笔记.md" }, { roots: [root] });
    assert.equal(loose.result.ok, true, "kind 大小写与空格要能归一");
  } finally { await rmTempDir(root); }
});

test("凭据文件被拒：路径与命令两条路都不许碰密钥", async () => {
  const root = makeWorkspace();
  try {
    fs.writeFileSync(path.join(root, ".env"), "API_KEY=sk-test\n");
    fs.writeFileSync(path.join(root, "auth.json"), "{\"token\":\"x\"}\n");

    const byPath = await one({ kind: "CONTAINS", target: ".env", expected: "sk-" }, { roots: [root] });
    assert.equal(byPath.result.ok, false);
    assert.match(byPath.result.detail, /凭据文件不参与断言/);

    const byAbs = await one({ kind: "SIZE_GT", target: path.join(root, "auth.json"), expected: 1 }, { roots: [root] });
    assert.equal(byAbs.result.ok, false);
    assert.match(byAbs.result.detail, /凭据文件不参与断言/);

    const byCmd = await one({ kind: "COUNT", command: "type auth.json | wc -l", op: "==", expected: 1 }, {
      roots: [root], run: async () => { throw new Error("不该被执行"); },
    });
    assert.equal(byCmd.result.ok, false);
    assert.match(byCmd.result.detail, /凭据文件/);
    assert.equal(assertCommandAllowed("type auth.json").rule, "secrets");
  } finally { await rmTempDir(root); }
});

test("汇总 passed/failed/total 与 ok 必须一致", async () => {
  const root = makeWorkspace();
  try {
    const s = await runClaims([
      { kind: "EXISTS", target: "生成物/图片/a.png" },
      { kind: "EXISTS", target: "生成物/图片/没有.png" },
      { kind: "COUNT", target: "生成物/图片", op: "==", expected: 2 },
      { kind: "SIZE_GT", target: "生成物/图片/a.png", expected: 99999 },
      { kind: "CONTAINS", target: "笔记.md", expected: "code-triad" },
    ], { roots: [root] });
    assert.equal(s.total, 5);
    assert.equal(s.passed, 3);
    assert.equal(s.failed, 2);
    assert.equal(s.ok, false);
    assert.equal(s.results.length, 5);
    for (const r of s.results) {
      for (const key of ["type", "target", "expected", "actual", "ok", "detail"]) {
        assert.ok(Object.hasOwn(r, key), `每条结果都要有 ${key}：${JSON.stringify(r)}`);
      }
    }
  } finally { await rmTempDir(root); }
});

test("人能读：✅/❌ 一行一条，FAIL 写「预期 X 实际 Y」", async () => {
  const root = makeWorkspace();
  try {
    const ok = await one({ kind: "EXISTS", target: "生成物/图片/a.png" }, { roots: [root] });
    assert.equal(formatClaimLine(ok.result), "✅ EXISTS 生成物/图片/a.png");

    const cmdFail = await one({ kind: "COUNT", command: "数行数", op: "==", expected: 92 }, { roots: [root], run: fakeRun("") });
    assert.equal(formatClaimLine(cmdFail.result), "❌ COUNT cmd: 数行数 行数 预期 92 实际 0");

    const report = formatClaimReport(await runClaims([
      { kind: "EXISTS", target: "生成物/图片/a.png" },
      { kind: "SIZE_EQ", target: "生成物/图片/b.png", expected: 11 },
    ], { roots: [root] }));
    const lines = report.split("\n");
    assert.match(lines[0], /断言闸门：2 条 · 通过 1 · 未过 1/);
    assert.match(report, /✅ EXISTS 生成物\/图片\/a\.png/);
    assert.match(report, /❌ SIZE_EQ 生成物\/图片\/b\.png 预期 11 实际 10/);
    assert.match(report, /别说完成/, "未过时要给下一步，否则模型照样会说完成");
    assert.doesNotMatch(report, /✅.*✅.*✅/, "通过的不许被渲染成噪声");
  } finally { await rmTempDir(root); }
});

test("断言类型表与模块契约（8 种、无任意 JS 求值）", () => {
  assert.deepEqual(ASSERTION_TYPES, ["EXISTS", "NOT_EXISTS", "COUNT", "CONTAINS", "LINE_EQ", "LINE_INCLUDES", "SIZE_GT", "SIZE_EQ"]);
  assert.equal(MAX_CLAIMS, 8);
  assert.equal(isInsideRoot("D:\\ws", "D:\\ws\\a\\b.txt"), true);
  assert.equal(isInsideRoot("D:\\ws", "D:\\ws2\\a.txt"), false);

  const src = read("engine", "claim-verify.mjs");
  assert.doesNotMatch(src, /(^|[^\w$.])eval\s*\(/m, "闸门里不许有 eval（这是硬纪律）");
  assert.doesNotMatch(src, /new\s+Function\s*\(/);
  assert.doesNotMatch(src, /from\s+["'](node:)?vm["']/);
  assert.match(src, /matchDenyRule/, "命令类断言必须过宪法红线");
  assert.match(src, /DANGEROUS_CMD_RE/, "命令类断言必须过危险命令拦截");
  assert.match(src, /execFile/, "默认执行器是 execFile（不是 shell 拼串求值）");
});

