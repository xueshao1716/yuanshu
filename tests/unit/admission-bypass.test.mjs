// 旁路留痕（admission-bypass）：追加/截断/字段截断/写失败不抛/倒序读取 + server.mjs 四个接入点的静态断言
// 2026-11-08：用户要的是"绕过可见"而不是"堵住"——所以这里只测记账，不测拦截。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  recordBypass, listBypasses, countBypasses, normalizeBypass, BYPASS_ROUTES,
  BYPASS_LEDGER, MAX_RECORDS, ROUTE_MAX, NOTE_MAX, FILES_MAX, FILE_MAX, EXTRA_MAX_CHARS,
} from "../../engine/admission-bypass.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = path.join(ROOT, "server.mjs");

const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-bypass-"));
const ledgerOf = (root) => path.join(root, BYPASS_LEDGER);
const readLines = (root) => fs.readFileSync(ledgerOf(root), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const seedLines = (root, rows) => {
  const file = ledgerOf(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
};

test("recordBypass：追加一行，记录结构 {at, route, files[], note, extra}", () => {
  const root = mkRoot();
  const at = "2026-11-08T12:00:00.000Z";
  const out = recordBypass({
    wsRoot: root,
    route: "selfchange.apply",
    files: ["engine/a.mjs", "tests/unit/a.test.mjs"],
    note: "直接 applyChange 写主树（未走自证准入）",
    at,
    extra: { id: "selfchange-1" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.kept, 1);

  const rows = readLines(root);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    at,
    route: "selfchange.apply",
    files: ["engine/a.mjs", "tests/unit/a.test.mjs"],
    note: "直接 applyChange 写主树（未走自证准入）",
    extra: { id: "selfchange-1" },
  });
  // 默认 at 也必须是可解析的 ISO 时间
  const out2 = recordBypass({ wsRoot: root, route: "autopatch.merge", files: [], note: "缺省时间" });
  assert.equal(out2.ok, true);
  const last = readLines(root).at(-1);
  assert.equal(Number.isNaN(Date.parse(last.at)), false, `at 不是合法时间：${last.at}`);
  assert.deepEqual(last.extra, {});
});

test("recordBypass：超过 500 行只留最近 500 行（最早的被丢）", () => {
  const root = mkRoot();
  const seeded = Array.from({ length: MAX_RECORDS + 5 }, (_, i) => ({
    at: new Date(1700000000000 + i * 1000).toISOString(),
    route: "seed",
    files: [],
    note: `seed-${i}`,
    extra: { seq: i },
  }));
  seedLines(root, seeded);
  assert.equal(countBypasses(root), MAX_RECORDS + 5);

  const out = recordBypass({ wsRoot: root, route: "selfchange.promote", files: ["engine/b.mjs"], note: "最后一条" });
  assert.equal(out.ok, true);
  assert.equal(out.dropped, 6);

  const rows = readLines(root);
  assert.equal(rows.length, MAX_RECORDS);
  // 505 条种子 + 1 条新记录 = 506，丢最早的 6 条 → 第一条应是 seq=6
  assert.equal(rows[0].extra.seq, 6);
  assert.equal(rows.at(-1).route, "selfchange.promote");
  assert.equal(countBypasses(root), MAX_RECORDS);
});

test("recordBypass：字段截断（note ≤200 / files ≤50 且每个 ≤200 / route ≤120 / extra 有上限）", () => {
  const root = mkRoot();
  const longNote = "记".repeat(NOTE_MAX + 500);
  // 每个路径的前 200 字不同（截断后仍可区分），才能验证到 50 个的上限
  const files = Array.from({ length: FILES_MAX + 10 }, (_, i) => `engine/${String(i).padStart(3, "0")}-${"d".repeat(FILE_MAX + 50)}.mjs`);
  const out = recordBypass({
    wsRoot: root,
    route: `selfchange.${"x".repeat(ROUTE_MAX + 100)}`,
    files,
    note: longNote,
    extra: { blob: "e".repeat(EXTRA_MAX_CHARS * 2) },
  });
  assert.equal(out.ok, true);

  const rec = readLines(root)[0];
  assert.equal(rec.note.length, NOTE_MAX);
  assert.equal(rec.route.length, ROUTE_MAX);
  assert.ok(rec.route.startsWith("selfchange."), "route 前缀要保留");
  assert.equal(rec.files.length, FILES_MAX);
  assert.ok(rec.files.every((f) => f.length <= FILE_MAX), "单个文件路径也要截断");
  assert.ok(JSON.stringify(rec.extra).length <= EXTRA_MAX_CHARS, "extra 序列化后要有上限");

  // 纯函数单测：非数组 files / 缺省 note / 非对象 extra 都不炸
  const plain = normalizeBypass({});
  assert.deepEqual(plain.files, []);
  assert.equal(plain.note, "");
  assert.equal(plain.route, "unknown");
  assert.ok(!Number.isNaN(Date.parse(plain.at)));
  assert.deepEqual(normalizeBypass({ files: "engine/a.mjs" }).files, []);
  assert.deepEqual(normalizeBypass({ extra: "just-text" }).extra, { value: "just-text" });
  // 重复文件只留一份
  assert.deepEqual(normalizeBypass({ files: ["a.mjs", "a.mjs", "b.mjs"] }).files, ["a.mjs", "b.mjs"]);
});

test("recordBypass：写失败只回 {ok:false,error}，绝不抛（用挡住的目录模拟只读）", () => {
  const root = mkRoot();
  // Windows 上 chmod 不一定挡得住写，改用"记忆 是文件不是目录"来制造同样的失败
  fs.writeFileSync(path.join(root, "记忆"), "not a dir", "utf8");
  assert.doesNotThrow(() => {
    const out = recordBypass({ wsRoot: root, route: "selfchange.apply", files: ["engine/a.mjs"], note: "写不进去" });
    assert.equal(out.ok, false);
    assert.equal(typeof out.error, "string");
    assert.ok(out.error.length > 0);
  });
  // 失败之后账本不存在，查询也只是空
  assert.deepEqual(listBypasses(root), []);
  assert.equal(countBypasses(root), 0);
  // 再来一次也不抛（调用方会一直走到原逻辑，不能因为记账失败中断）
  assert.equal(recordBypass({ wsRoot: root, route: "selfchange.apply" }).ok, false);
});

test("listBypasses：倒序（最新在前）+ limit 生效", () => {
  const root = mkRoot();
  recordBypass({ wsRoot: root, route: "selfchange.apply", files: [], note: "第一条", at: "2026-11-08T01:00:00.000Z" });
  recordBypass({ wsRoot: root, route: "selfchange.promote", files: [], note: "第二条", at: "2026-11-08T02:00:00.000Z" });
  recordBypass({ wsRoot: root, route: "autopatch.merge", files: [], note: "第三条", at: "2026-11-08T03:00:00.000Z" });

  assert.deepEqual(listBypasses(root).map((r) => r.note), ["第三条", "第二条", "第一条"]);
  assert.deepEqual(listBypasses(root, { limit: 2 }).map((r) => r.note), ["第三条", "第二条"]);
  assert.deepEqual(listBypasses(root, { limit: 9999 }).map((r) => r.note).length, 3);
  assert.deepEqual(listBypasses(root, { limit: 0 }).map((r) => r.note), ["第三条"]);
  // 不存在的账本 → 空数组，不抛
  assert.deepEqual(listBypasses(path.join(root, "nope")), []);
});

test("listBypasses：坏行跳过，好行照读", () => {
  const root = mkRoot();
  const file = ledgerOf(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const good1 = JSON.stringify({ at: "2026-11-08T01:00:00.000Z", route: "selfchange.apply", files: [], note: "好的1", extra: {} });
  const good2 = JSON.stringify({ at: "2026-11-08T02:00:00.000Z", route: "selfchange.promote", files: [], note: "好的2", extra: {} });
  fs.writeFileSync(file, `${good1}\n{坏行不是 JSON\n${good2}\n`, "utf8");
  assert.deepEqual(listBypasses(root).map((r) => r.note), ["好的2", "好的1"]);
  assert.equal(countBypasses(root), 2);
});

// ── 静态断言：四个旁路点都接了 recordBypass，且都排在真正写操作之前 ──────────────
const serverLines = fs.readFileSync(SERVER, "utf8").split(/\r?\n/);
const lineOf = (needle, from = 0) => {
  for (let i = from; i < serverLines.length; i += 1) if (serverLines[i].includes(needle)) return i + 1;
  return 0;
};

test("server.mjs：apply / promote / snapshot / autopatch.merge 四个旁路点都调了 recordBypass", () => {
  const wired = [
    { route: "selfchange.apply", declare: '["POST", "/api/selfchange/apply"' },
    { route: "selfchange.promote", declare: '["POST", "/api/selfchange/promote"' },
    { route: "selfchange.snapshot", declare: '["POST", "/api/selfchange/snapshot/begin"' },
    { route: "autopatch.merge", declare: '["POST", "/api/autopatch/merge"' },
  ];
  for (const { route, declare } of wired) {
    const start = lineOf(declare);
    assert.ok(start > 0, `找不到路由声明：${declare}`);
    const record = lineOf(`recordBypass({`, start - 1);
    assert.ok(record > 0, `${route} 没有 recordBypass 调用`);
    assert.ok(record >= start && record <= start + 30, `${route} 的 recordBypass 不在路由入口附近（line ${record}）`);
    assert.ok(serverLines[record - 1].includes(`route: "${route}"`), `${route} 的 route 标识不对：${serverLines[record - 1].slice(0, 160)}`);
  }
  // 稳定标识就这四个，不多不少（写错标识会让面板/审计对不上）
  assert.deepEqual(wired.map((x) => x.route).sort(), [...BYPASS_ROUTES].sort());
  // 模块本身也被 import 进了 server.mjs
  assert.ok(serverLines.some((l) => l.includes('from "./engine/admission-bypass.mjs"')), "server.mjs 没 import admission-bypass.mjs");
});

test("server.mjs：recordBypass 都在实际写操作之前（按行号断言）", () => {
  const cases = [
    { route: "selfchange.promote", write: "fs.mkdirSync(backupDir" },
    { route: "selfchange.snapshot", write: "beginFsSnapshot({ root: WS_ROOT })" },
    { route: "selfchange.apply", write: "const out = applyChange({ wsRoot: SELF_CHANGE_ROOT" },
    { route: "autopatch.merge", write: "const out = mergeBranch(PATCH_REPO.root" },
  ];
  for (const { route, write } of cases) {
    const record = lineOf(`route: "${route}"`);
    assert.ok(record > 0, `找不到 ${route} 的 recordBypass 行`);
    const writeAt = lineOf(write, record);
    assert.ok(writeAt > 0, `找不到 ${route} 的写操作：${write}`);
    assert.ok(record < writeAt, `${route} 的留痕（line ${record}）必须早于写操作（line ${writeAt}）`);
    assert.ok(writeAt - record <= 12, `${route} 留痕离写操作太远（line ${record} → ${writeAt}）`);
  }
});

test("server.mjs：GET /api/self-change/bypasses 返回 {ok, items, total}", () => {
  const start = lineOf('["GET", "/api/self-change/bypasses"');
  assert.ok(start > 0, "缺 /api/self-change/bypasses 接口");
  const items = lineOf("items: listBypasses(WS_ROOT", start - 1);
  const total = lineOf("total: countBypasses(WS_ROOT)", start - 1);
  assert.ok(items > 0 && items <= start + 8, "接口没回 items: listBypasses(WS_ROOT)");
  assert.ok(total > 0 && total <= start + 8, "接口没回 total: countBypasses(WS_ROOT)");
  assert.ok(lineOf("limit", start - 1) > 0, "接口没处理 limit 参数");
});
