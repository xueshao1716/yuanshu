// 2026-11-14：工具面诊断盲区——每轮工具表快照 + 工具硬失败落失败台账。
// 盲区一：没有任何地方记录「这一轮实际下发了哪些工具」，只能翻会话原文反推。
// 盲区二：失败台账 10-28 起停更，其实工具超时/verify_check 断言未过天天有，只是没人写。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  SURFACE_REL, MAX_SURFACE_LINES, MAX_DROPPED_NAMES,
  surfaceFingerprint, buildSurfaceEntry, formatToolSurfaceLine,
  recordToolSurface, readToolSurface, handleToolSurfaceRoute,
  isLedgerWorthyToolFailure, recordToolFailure,
} from "../../engine/tool-surface-log.mjs";
import { executeVerifyCheck } from "../../engine/tools/verify-check.mjs";
import { createUnifiedToolExecutor } from "../../engine/tools/unified-tools.mjs";
import { readFailures } from "../../engine/failure-ledger.mjs";
import { json } from "../../engine/http-utils.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "surface-"));
const surfaceFile = (root) => path.join(root, SURFACE_REL);
const readLines = (root) => fs.readFileSync(surfaceFile(root), "utf8").split("\n").filter(Boolean);
const defs = (names) => names.map((n) => ({ type: "function", function: { name: n, parameters: { type: "object", properties: {} } } }));
// 快照会打 [tools] 日志；除了专门测日志的那条，其余测试静默掉，输出干净。
const silent = (fn) => {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
};

test("快照落盘：字段按契约（sessionId 后 6 位 / tier / total / sent / dropped）", () => {
  const root = ws();
  const r = silent(() => recordToolSurface({
    wsRoot: root, sessionId: "01a1d9a6-97a7-75dd-95a8-7ee448d80c92", tier: 0.5,
    allTools: defs(["read", "write", "bash"]), sentTools: defs(["read"]),
    at: "2026-11-14T10:42:16.391Z",
  }));
  assert.equal(r.ok, true);
  assert.equal(r.written, true);
  const [entry] = readToolSurface(root);
  assert.equal(entry.at, "2026-11-14T10:42:16.391Z");
  assert.equal(entry.sessionId, "d80c92");
  assert.equal(entry.tier, 0.5);
  assert.equal(entry.total, 3);
  assert.equal(entry.sent, 1);
  assert.deepEqual(entry.dropped, ["write", "bash"]);
  assert.equal(entry.droppedTotal, 2);
});

test("tier 取不到写 null（不写 0、不写 undefined）", () => {
  const e = buildSurfaceEntry({ tier: undefined, allTools: defs(["read"]), sentTools: defs(["read"]) });
  assert.equal(e.tier, null);
  assert.equal(e.droppedTotal, 0);
  assert.equal(formatToolSurfaceLine(e), "[tools] sent=1/1 tier=null dropped=0");
});

test("相同内容不重复写：at / sessionId 变了也算同一条（按内容哈希去重）", () => {
  const root = ws();
  const args = { wsRoot: root, tier: 0.1, allTools: defs(["read", "write", "story_x"]), sentTools: defs(["read", "write"]) };
  const first = silent(() => recordToolSurface({ ...args, sessionId: "aaaaaaaa-1111", at: "2026-11-14T01:00:00.000Z" }));
  const second = silent(() => recordToolSurface({ ...args, sessionId: "bbbbbbbb-2222", at: "2026-11-14T02:00:00.000Z" }));
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(second.duplicate, true);
  assert.equal(readLines(root).length, 1, "同内容只留一行，不随每轮刷屏");
  // 内容变了（sent 从 2 → 3）才算新快照
  const third = silent(() => recordToolSurface({ ...args, sentTools: defs(["read", "write", "story_x"]), sessionId: "cccccccc-3333" }));
  assert.equal(third.written, true);
  assert.equal(readLines(root).length, 2);
});

test("dropped 截断为 10 个名字 + 总数", () => {
  const root = ws();
  const all = Array.from({ length: 18 }, (_, i) => `tool_${i}`);
  const r = silent(() => recordToolSurface({ wsRoot: root, tier: 0.1, allTools: defs(all), sentTools: [] }));
  assert.equal(r.entry.dropped.length, MAX_DROPPED_NAMES);
  assert.equal(r.entry.droppedTotal, 18);
  const [entry] = readToolSurface(root);
  assert.equal(entry.dropped.length, 10);
  assert.equal(entry.droppedTotal, 18);
  assert.match(r.line, /dropped=18$/);
});

test("超过 2000 行裁剪：只留最近 2000 行", () => {
  const root = ws();
  const file = surfaceFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seed = [];
  for (let i = 0; i < MAX_SURFACE_LINES + 100; i += 1) {
    // 每条内容都不同，确保不会被去重拦住；最后一条与接下来新写的也不同
    seed.push(JSON.stringify({ at: `2026-11-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, sessionId: String(i), tier: 0.1, total: 3, sent: i % 3, dropped: ["x"], droppedTotal: 1 }));
  }
  fs.writeFileSync(file, seed.join("\n") + "\n", "utf8");
  const r = silent(() => recordToolSurface({ wsRoot: root, tier: 0.5, allTools: defs(["a", "b"]), sentTools: defs(["a"]) }));
  assert.equal(r.ok, true);
  assert.equal(r.trimmed, true);
  const lines = readLines(root);
  assert.equal(lines.length, MAX_SURFACE_LINES, `裁剪后应为 ${MAX_SURFACE_LINES} 行`);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.tier, 0.5);
  const first = JSON.parse(lines[0]);
  assert.equal(first.sessionId, String(MAX_SURFACE_LINES + 100 - MAX_SURFACE_LINES + 1), "最老的行应被裁掉");
});

test("GET /api/tools/surface：返回最近快照（新的在前），limit 生效", async () => {
  const root = ws();
  silent(() => {
    recordToolSurface({ wsRoot: root, tier: 0.1, allTools: defs(["a", "b"]), sentTools: defs(["a"]) });
    recordToolSurface({ wsRoot: root, tier: 0.5, allTools: defs(["a", "b", "c"]), sentTools: defs(["a", "b"]) });
    recordToolSurface({ wsRoot: root, tier: 0.8, allTools: defs(["a", "b", "c"]), sentTools: defs(["a", "b", "c"]) });
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    return handleToolSurfaceRoute(res, req, url, { wsRoot: root, json });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/tools/surface?limit=2`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.file, "记忆/运行时/工具表.jsonl");
    assert.equal(body.maxLines, MAX_SURFACE_LINES);
    assert.equal(body.count, 2);
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].tier, 0.8, "最新一条在前");
    assert.equal(body.items[1].tier, 0.5);
    const fallback = await (await fetch(`http://127.0.0.1:${port}/api/tools/surface`)).json();
    assert.equal(fallback.count, 3, "默认 limit=20，三条都在");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("没有工作区根时不写（测试/嵌入场景不污染进程 cwd）", () => {
  const r = recordToolSurface({ wsRoot: "", tier: 0.5, allTools: defs(["a"]), sentTools: defs(["a"]) });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, "no-workspace");
  const stray = fileURLToPath(new URL("../../记忆/运行时/工具表.jsonl", import.meta.url));
  assert.equal(fs.existsSync(stray), false);
});

test("内容哈希只看工具面，不看 at/sessionId", () => {
  const a = buildSurfaceEntry({ at: "2026-11-14T01:00:00.000Z", sessionId: "aaa", tier: 0.5, allTools: defs(["a", "b"]), sentTools: defs(["a"]) });
  const b = buildSurfaceEntry({ at: "2026-11-14T09:00:00.000Z", sessionId: "bbb", tier: 0.5, allTools: defs(["a", "b"]), sentTools: defs(["a"]) });
  assert.equal(surfaceFingerprint(a), surfaceFingerprint(b));
  const c = buildSurfaceEntry({ tier: 0.5, allTools: defs(["a", "b"]), sentTools: defs(["b"]) });
  assert.notEqual(surfaceFingerprint(a), surfaceFingerprint(c));
});

test("[tools] 日志只在数字或 dropped 变化时打（正常轮次无噪音）", () => {
  const root = ws();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const base = { wsRoot: root, sessionId: "s-1", tier: 0.5, allTools: defs(["read", "write", "bash"]), sentTools: defs(["read"]) };
    recordToolSurface(base);
    recordToolSurface(base);
    recordToolSurface({ ...base, sessionId: "s-2", at: new Date().toISOString() });   // 内容没变
    recordToolSurface({ ...base, sentTools: defs(["read", "write"]) });               // 发出数变了
  } finally {
    console.log = orig;
  }
  assert.equal(logs.length, 2, "4 轮里只有 2 次真实变化 → 只打 2 行");
  assert.equal(logs[0], "[tools] sent=1/3 tier=0.5 dropped=2");
  assert.equal(logs[1], "[tools] sent=2/3 tier=0.5 dropped=1");
});

// ── 盲区二：工具失败 → 失败台账 ──────────────────────────────────────

test("失败台账：工具超时能落账（source=tool，走真实台账读取）", () => {
  const root = ws();
  const out = { isError: true, code: "TOOL_TIMEOUT", text: "⏱ 命令超过 120 秒被终止（已杀进程树）。不要原样重试：\n- grep 递归要加 --exclude-dir=node_modules" };
  const sessionId = "01a1d9a6-97a7-75dd-95a8-7ee448d80c92";
  const r = recordToolFailure({ wsRoot: root, name: "bash", out, args: { command: "grep -rn foo engine/" }, sessionId, at: 1794652958273 });
  assert.equal(r.ok, true);
  const items = readFailures(root).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "tool");
  assert.equal(items[0].area, "工具：bash");
  assert.match(items[0].why, /120 秒/);
  assert.match(items[0].attempt, /grep -rn foo engine\//);
  assert.match(items[0].attempt, new RegExp(String(sessionId).slice(-6)));
  assert.equal(items[0].evidence, "TOOL_TIMEOUT");
});

test("失败台账：一次真实失败调用（verify_check 请求不存在的文件）能落账", async () => {
  const root = ws();
  const claims = [{ kind: "EXISTS", target: "生成物/图片/根本没有这张图.png" }];
  const out = await executeVerifyCheck({ claims }, { cwd: root, roots: [root] });
  assert.equal(out.isError, true, "断言未过时执行器必须回 isError");
  assert.match(out.text, /❌/);

  const r = recordToolFailure({ wsRoot: root, name: "verify_check", out, args: { claims }, sessionId: "01a1d9a6-97a7-75dd-95a8-7ee448d80c92" });
  assert.equal(r.ok, true);
  const items = readFailures(root).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "tool");
  assert.equal(items[0].area, "工具：verify_check");
  assert.ok(items[0].files.includes("生成物/图片/根本没有这张图.png"), "断言目标要进 files，便于开工前召回");
});

test("失败台账：故意读一个不存在的文件（真实 read 执行器）能落账", async () => {
  const root = ws();
  const execute = createUnifiedToolExecutor({ cwd: () => root, safePath: (p) => path.resolve(root, String(p || "")) });
  const out = await execute("read", { path: "生成物/根本没有这个文件.txt" }, {});
  assert.equal(out.isError, true, "读不存在的文件必须回 isError");
  assert.match(out.text, /文件不存在/);
  const r = recordToolFailure({ wsRoot: root, name: "read", out, args: { path: "生成物/根本没有这个文件.txt" }, sessionId: "01a1d9a6-97a7-75dd-95a8-7ee448d80c92" });
  assert.equal(r.ok, true);
  const items = readFailures(root).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "tool");
  assert.equal(items[0].area, "工具：read");
  assert.ok(items[0].files.includes("生成物/根本没有这个文件.txt"));
});

test("失败台账：普通非零退出 / 被红线拦住 不算失败，不落账", () => {
  const root = ws();
  assert.equal(isLedgerWorthyToolFailure("bash", { isError: true, text: "(无输出)\n[退出码 1]" }), false);
  assert.equal(isLedgerWorthyToolFailure("bash", { isError: true, denied: true, text: "[系统拦截] 不允许改人格" }), false);
  assert.equal(isLedgerWorthyToolFailure("read", { isError: true, text: "⛔ 参数不合法" }), false);
  assert.equal(isLedgerWorthyToolFailure("bash", { isError: false, text: "ok" }), false);
  const r = recordToolFailure({ wsRoot: root, name: "bash", out: { isError: true, text: "(无输出)\n[退出码 1]" } });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, "not-worthy");
  assert.equal(readFailures(root).items.length, 0);
});

test("失败台账：30 分钟内同一形态失败只记一条（工具循环重试不刷屏）", () => {
  const root = ws();
  const out = { isError: true, text: "⏱ 命令超过 120 秒被终止（已杀进程树）。" };
  const args = { command: "node slow.mjs" };
  const sessionId = "01a1d9a6-97a7-75dd-95a8-7ee448d80c92";
  const a = recordToolFailure({ wsRoot: root, name: "bash", out, args, sessionId, at: 1794652958273 });
  const b = recordToolFailure({ wsRoot: root, name: "bash", out, args, sessionId, at: 1794652958273 + 60_000 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.skipped, "duplicate");
  assert.equal(readFailures(root).items.length, 1);
});

test("接线：unified-chat 每轮记快照 + 硬失败记账，server 有 GET /api/tools/surface", () => {
  const chat = fs.readFileSync(fileURLToPath(new URL("../../engine/unified-chat.mjs", import.meta.url)), "utf8");
  assert.ok(chat.includes("recordToolSurface({"), "unified-chat 必须记快照");
  assert.ok(chat.includes("filterToolsByTier(rawToolDefs, toolWeights)"), "快照必须接在裁剪同一处");
  assert.ok(chat.includes("recordToolFailure({ wsRoot: _wsRoot || _cwd"), "onToolEnd 必须把硬失败写台账");
  const server = fs.readFileSync(fileURLToPath(new URL("../../server.mjs", import.meta.url)), "utf8");
  assert.ok(server.includes('["GET", "/api/tools/surface"'), "只读接口必须注册在 API_ROUTES（统一鉴权）");
});
