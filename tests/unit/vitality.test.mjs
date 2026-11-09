// 机制产出新鲜度看板（2026-11-09）。
// 锁五件事：
//   ① fresh / stale / never / unknown 四种状态各判对一次（尤其 never 与 unknown 不许互相顶替）；
//   ② 证据源缺失 = unknown 而**不是** never（"文件都没有"和"从没写过"是两件事）；
//   ③ 阈值可覆盖（单机制 / 天数写法 / 全局 default）；
//   ④ JSONL 的行数统计与最后时间（含坏行、时间读不出、before/after 双写去重）；
//   ⑤ summarize 有红项时必须点名具体机制，不许只说"有 N 项异常"。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MECHANISMS, auditVitality, auditOne, summarize, countStates, stateLabel,
  resolveThreshold, toMs, pick, rowMatches, globMatchName, formatTime, humanAge,
} from "../../engine/vitality.mjs";
import { parseArgs, exitCodeFor, renderTable } from "../../scripts/vitality.mjs";

const DAY = 86400000;
const mkWs = () => fs.mkdtempSync(path.join(os.tmpdir(), "vitality-"));

function writeJsonl(ws, rel, rows) {
  const f = path.join(ws, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + (rows.length ? "\n" : ""), "utf8");
  return f;
}
function writeJson(ws, rel, obj) {
  const f = path.join(ws, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
  return f;
}

// 只测一项时用的最小清单（不牵真实清单，免得清单改了测试就红）
const one = (over = {}) => [{
  id: "probe", name: "探针", kind: "jsonl",
  paths: ["记忆/运行时/探针.jsonl"], timeField: "at",
  staleAfterMs: 3 * DAY, criterion: "≤3 天", note: "测试用", code: "engine/probe.mjs",
  ...over,
}];
const auditOneOf = (ws, over = {}, opts = {}) =>
  auditVitality({ wsRoot: ws, mechanisms: one(over), ...opts }).items[0];

describe("机制清单是完整清单，不是空壳", () => {
  test("覆盖任务点名的那 9 类机制", () => {
    const ids = MECHANISMS.map((m) => m.id);
    for (const need of [
      "emotion-event", "relationship", "gene-drift", "growth", "outreach",
      "watchdog-incident", "forget-report", "self-proof", "verify-check",
    ]) assert.ok(ids.includes(need), `清单缺机制 ${need}`);
    assert.equal(new Set(ids).size, ids.length, "机制 id 不许重复");
  });

  test("每项都带得出判据/阈值/落盘源码，否则看板只能报红说不出人话", () => {
    for (const m of MECHANISMS) {
      assert.ok(m.name, `${m.id} 缺中文名`);
      assert.ok(m.criterion, `${m.id} 缺判据文字`);
      assert.ok(m.note, `${m.id} 缺说明`);
      assert.ok(m.code, `${m.id} 缺 code（该写它的源码）`);
      assert.ok(Number.isFinite(m.staleAfterMs) && m.staleAfterMs > 0, `${m.id} 阈值不对`);
      assert.ok(Array.isArray(m.paths) && m.paths.length > 0, `${m.id} 缺证据源`);
      assert.ok(["jsonl", "json", "glob"].includes(m.kind), `${m.id} kind 非法`);
      assert.ok(["turn", "background", "manual"].includes(m.cadence), `${m.id} cadence 非法：${m.cadence}`);
    }
  });

  test("cadence 标对：轮末驱动 / 后台驱动 / 手动，别把'没聊过'和'被挡住'混成一种", () => {
    const by = Object.fromEntries(MECHANISMS.map((m) => [m.id, m.cadence]));
    assert.equal(by.relationship, "turn");
    assert.equal(by.growth, "turn");
    assert.equal(by["emotion-event"], "turn");
    assert.equal(by.outreach, "background", "主动触达是后台 sweep 驱动的");
    assert.equal(by["watchdog-incident"], "background");
    assert.equal(by["forget-report"], "manual", "遗忘报告只有人跑 --apply 才写");
  });
});

describe("时间归一 toMs", () => {
  test("毫秒数、秒数、ISO 字符串都能认", () => {
    const ms = Date.parse("2026-11-09T00:00:00.000Z");
    assert.equal(toMs(ms), ms);
    assert.equal(toMs(Math.round(ms / 1000)), ms, "10 位当秒");
    assert.equal(toMs("2026-11-09T00:00:00.000Z"), ms);
  });

  test("认不出的返回 null，**不猜**（猜出来的时间会把 never 洗成 fresh）", () => {
    for (const bad of [null, undefined, "", "不是时间", NaN, -5, {}]) {
      assert.equal(toMs(bad), null, `${String(bad)} 应该返回 null`);
    }
  });
});

describe("四种状态各判对一次", () => {
  test("fresh：证据源在，最后产出在阈值内", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJsonl(ws, "记忆/运行时/探针.jsonl", [{ at: now - 3600_000 }, { at: now - 600_000 }]);
    const it = auditOneOf(ws, {}, { now });
    assert.equal(it.state, "fresh");
    assert.equal(it.count, 2);
    assert.equal(it.lastAt, now - 600_000, "取最新一条的时间，不是第一条");
    assert.match(it.detail, /最后产出/);
  });

  test("stale：证据源在，但最后产出超阈值", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJsonl(ws, "记忆/运行时/探针.jsonl", [{ at: now - 5 * DAY }]);
    const it = auditOneOf(ws, {}, { now });
    assert.equal(it.state, "stale");
    assert.ok(it.ageMs >= 5 * DAY - 1000);
    assert.match(it.detail, /超过阈值/);
  });

  test("never：文件在，但一条匹配的产出都没有", () => {
    const ws = mkWs();
    writeJsonl(ws, "记忆/运行时/探针.jsonl", []); // 空文件：载体建起来了，没落账
    const it = auditOneOf(ws, {}, { now: Date.parse("2026-11-09T12:00:00.000Z") });
    assert.equal(it.state, "never");
    assert.equal(it.count, 0);
    assert.equal(it.lastAt, null);
    assert.match(it.detail, /命中 0 行/);
  });

  test("unknown：证据源本身不存在", () => {
    const ws = mkWs();
    const it = auditOneOf(ws, {}, { now: Date.parse("2026-11-09T12:00:00.000Z") });
    assert.equal(it.state, "unknown");
    assert.match(it.detail, /证据源缺失/);
  });

  test("四种状态都是合法取值，stateLabel 有中文且互不相同", () => {
    const labels = ["fresh", "stale", "never", "unknown"].map(stateLabel);
    assert.equal(new Set(labels).size, 4, `状态中文名撞车了：${labels.join("/")}`);
    for (const l of labels) assert.ok(/[\u4e00-\u9fa5]/.test(l), `状态名要中文：${l}`);
  });
});

describe("never 与 unknown 的界线：从没写过 vs 文件都没有", () => {
  test("证据源缺失 → unknown，**不是** never", () => {
    const ws = mkWs();
    const it = auditOneOf(ws);
    assert.equal(it.state, "unknown");
    assert.notEqual(it.state, "never", "文件都没有就不能说'从未产出'");
  });

  test("文件在但只有不匹配的行 → never，且 detail 报出全文字数", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJsonl(ws, "记忆/运行时/探针.jsonl", [
      { at: now, source: "round" },
      { at: now - 1000, source: "round" },
      { at: now - 2000 }, // 连 source 都没有，不该命中
    ]);
    const it = auditOneOf(ws, { match: { field: "source", prefix: "event:" } }, { now });
    assert.equal(it.state, "never");
    assert.equal(it.count, 0);
    assert.match(it.detail, /全文 3 行/, "要能看出'行不少但它一条都没写'，而不是'文件是空的'");
  });

  test("文件坏了读不了 → unknown（不是 never，也不是 fresh）", () => {
    const ws = mkWs();
    writeJson(ws, "记忆/运行时/探针.jsonl", "{ 这不是 JSON");
    const it = auditVitality({
      wsRoot: ws,
      mechanisms: one({ kind: "json", timeField: undefined, timePath: "updatedAt" }),
    }).items[0];
    assert.equal(it.state, "unknown");
    assert.match(it.detail, /读不了/);
  });

  test("证据目录都没有（glob 型）→ unknown", () => {
    const ws = mkWs();
    const it = auditVitality({
      wsRoot: ws,
      mechanisms: [{ id: "g", name: "报告", kind: "glob", paths: ["记忆/运行时"], pattern: "报告-*.md", staleAfterMs: DAY, criterion: "", note: "" }],
    }).items[0];
    assert.equal(it.state, "unknown");
    assert.match(it.detail, /目录不存在/);
  });

  test("目录在但从没写过任何一份报告 → never", () => {
    const ws = mkWs();
    fs.mkdirSync(path.join(ws, "记忆", "运行时"), { recursive: true });
    const it = auditVitality({
      wsRoot: ws,
      mechanisms: [{ id: "g", name: "报告", kind: "glob", paths: ["记忆/运行时"], pattern: "报告-*.md", staleAfterMs: DAY, criterion: "", note: "" }],
    }).items[0];
    assert.equal(it.state, "never");
    assert.match(it.detail, /一份都没写出来/);
  });
});

describe("JSONL 行数统计与最后时间", () => {
  test("只数命中行；坏行跳过但不影响判定", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJsonl(ws, "记忆/运行时/探针.jsonl", [
      { at: now - 3000, tool: "verify_check" },
      "这一行坏掉了",
      { at: now - 2000, tool: "bash" },
      { at: now - 1000, tool: "verify_check" },
    ]);
    const it = auditOneOf(ws, { match: { field: "tool", equals: "verify_check" } }, { now });
    assert.equal(it.count, 2, "只数 tool=verify_check 的两行");
    assert.equal(it.lastAt, now - 1000);
    assert.equal(it.state, "fresh");
    assert.match(it.detail, /坏行 1/);
  });

  test("notPhase 去重：审计 before/after 双写只算一次调用", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJsonl(ws, "记忆/运行时/探针.jsonl", [
      { at: now, tool: "verify_check" },
      { at: now, tool: "verify_check", phase: "after" },
    ]);
    const it = auditOneOf(ws, { match: { field: "tool", equals: "verify_check", notPhase: "after" } }, { now });
    assert.equal(it.count, 1);
  });

  test("命中行有时间字段却一条时间都读不出 → unknown，**不许**当 fresh", () => {
    const ws = mkWs();
    writeJsonl(ws, "记忆/运行时/探针.jsonl", [{ foo: 1 }, { foo: 2 }]);
    const it = auditOneOf(ws, {}, { now: Date.parse("2026-11-09T12:00:00.000Z") });
    assert.equal(it.count, 2);
    assert.equal(it.state, "unknown", "有产出但判不了新鲜度，只能 unknown");
    assert.match(it.detail, /时间都读不出来/);
  });

  test("时间落在未来 → unknown（时钟坏了不能给绿）", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJsonl(ws, "记忆/运行时/探针.jsonl", [{ at: now + 30 * DAY }]);
    const it = auditOneOf(ws, {}, { now });
    assert.equal(it.state, "unknown");
    assert.match(it.detail, /在未来/);
  });

  test("多个证据路径合并计数（例如 情绪潮汐 有两个历史位置）", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJsonl(ws, "a.jsonl", [{ at: now - 5000 }, { at: now - 4000 }]);
    writeJsonl(ws, "b.jsonl", [{ at: now - 1000 }]);
    const it = auditOneOf(ws, { paths: ["a.jsonl", "b.jsonl"] }, { now });
    assert.equal(it.count, 3);
    assert.equal(it.lastAt, now - 1000, "跨文件取最大时间");
    assert.equal(it.state, "fresh");
  });
});

describe("JSON 探针（关系/基因/成长/看门狗都是这种）", () => {
  const jsonItem = (over = {}) => one({
    kind: "json", paths: ["记忆/运行时/状态.json"],
    timeField: undefined, timePath: "updatedAt", countPath: "count", ...over,
  });

  test("timePath + countPath 都能取到（ISO 字符串）", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJson(ws, "记忆/运行时/状态.json", { updatedAt: new Date(now - 3600_000).toISOString(), count: 7 });
    const it = auditVitality({ wsRoot: ws, now, mechanisms: jsonItem() }).items[0];
    assert.equal(it.state, "fresh");
    assert.equal(it.count, 7);
    assert.equal(it.lastAt, now - 3600_000);
  });

  test("countPath 支持点分路径（成长的 evidence.turns）", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJson(ws, "记忆/运行时/状态.json", { updatedAt: new Date(now).toISOString(), evidence: { turns: 12 } });
    const it = auditVitality({ wsRoot: ws, now, mechanisms: jsonItem({ countPath: "evidence.turns" }) }).items[0];
    assert.equal(it.count, 12);
  });

  test("时间字段为空的文档 → never（文件建了壳但一次都没写进时间）", () => {
    const ws = mkWs();
    writeJson(ws, "记忆/运行时/状态.json", { updatedAt: null, count: 3 });
    const it = auditVitality({ wsRoot: ws, mechanisms: jsonItem() }).items[0];
    assert.equal(it.state, "never");
    assert.match(it.detail, /updatedAt 为空/);
  });

  test("毫秒数时间也认（看门狗事件 updatedAt 是 ms）", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJson(ws, "记忆/运行时/状态.json", {
      updatedAt: now - 7200_000,
      items: Array.from({ length: 25 }, (_, i) => ({ id: `incident-${i}` })),
    });
    const it = auditVitality({ wsRoot: ws, now, mechanisms: jsonItem({ countPath: "items" }) }).items[0];
    assert.equal(it.state, "fresh");
    assert.equal(it.count, 25);
    assert.equal(it.lastAt, now - 7200_000);
  });
});

describe("阈值可覆盖", () => {
  test("单机制覆盖：同一条证据，阈值一收紧就从 fresh 变 stale", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJsonl(ws, "记忆/运行时/探针.jsonl", [{ at: now - 2 * DAY }]);
    assert.equal(auditOneOf(ws, {}, { now }).state, "fresh", "默认 3 天 → 新鲜");
    assert.equal(auditOneOf(ws, {}, { now, thresholds: { probe: 1 * DAY } }).state, "stale");
  });

  test("也认 { days } 写法和全局 default", () => {
    const item = one()[0];
    assert.equal(resolveThreshold(item, { probe: { days: 7 } }), 7 * DAY);
    assert.equal(resolveThreshold(item, { probe: { staleAfterMs: 1234 } }), 1234);
    assert.equal(resolveThreshold(item, { default: 9 * DAY }), 9 * DAY);
    assert.equal(resolveThreshold(item, {}), item.staleAfterMs, "没覆盖就用清单里的");
  });

  test("lastRowFlag：最后一条失败的记录会进 detail（也进 flags）", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJsonl(ws, "记忆/运行时/探针.jsonl", [
      { at: now - 1000, ok: false, reason: "自证未过：deps 失败" },
    ]);
    const it = auditOneOf(ws, { lastRowFlag: (r) => (r.ok === false ? `最后一条是失败的（${r.reason}）` : null) }, { now });
    assert.equal(it.state, "fresh", "跑过就是跑过，状态不因为结果坏而变");
    assert.match(it.detail, /失败/);
    assert.equal(it.flags.length, 1);
    assert.match(it.flags[0], /deps/);
  });

  test("阈值会写进审计结果，报告里能看出这一轮按几天判的", () => {
    const ws = mkWs();
    const it = auditOneOf(ws, {}, { thresholds: { probe: 5 * DAY } });
    assert.equal(it.thresholdDays, 5);
  });
});

describe("summarize 的措辞", () => {
  const mkAudit = (items) => ({ items, counts: countStates(items) });

  test("有红项时必须点名具体机制，不许只说'有 N 项异常'", () => {
    const s = summarize(mkAudit([
      { id: "growth", name: "成长", state: "never", count: 0, detail: "证据源在但 0 行", code: "engine/genome-growth.mjs" },
      { id: "outreach", name: "主动触达", state: "stale", count: 3, detail: "最后产出 9 天前", code: "engine/proactive-journal.mjs" },
      { id: "relationship", name: "关系", state: "fresh", count: 12, detail: "最后产出 1 小时前", code: "" },
    ]));
    assert.match(s.line, /成长/);
    assert.match(s.line, /主动触达/);
    assert.match(s.line, /要处理/);
    assert.doesNotMatch(s.line, /有 ?2 ?项异常/, "这句等于没说，读三遍也不知道去修什么");
    assert.equal(s.issues.length, 2);
    assert.equal(s.needsAttention, 2);
    assert.equal(s.ok, false);
  });

  test("未知项单独列，不跟红项混（unknown 不等于坏，但也不许当绿）", () => {
    const s = summarize(mkAudit([
      { id: "a", name: "甲", state: "unknown", count: 0, detail: "证据源缺失", code: "" },
      { id: "b", name: "乙", state: "fresh", count: 1, detail: "", code: "" },
    ]));
    assert.equal(s.issues.length, 0);
    assert.equal(s.unknown.length, 1);
    assert.match(s.line, /无证据/);
    assert.match(s.line, /甲/);
    assert.equal(s.ok, true, "unknown 不算红项（但摘要里必须提出来）");
  });

  test("红项超过 6 个时截断但仍然报总数", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, name: `机制${i}`, state: "stale", count: 1, detail: "", code: "" }));
    const s = summarize(mkAudit(many));
    assert.match(s.line, /等 8 项/);
    assert.equal(s.issues.length, 8, "line 可以截断，issues 不许截断");
  });

  test("全绿时给出明确结论，不留悬念", () => {
    const s = summarize(mkAudit([{ id: "a", name: "甲", state: "fresh", count: 2, detail: "", code: "" }]));
    assert.match(s.line, /没有停更或从未产出的机制/);
    assert.equal(s.ok, true);
  });

  test("状态绿但证据本身有事（自证跑过、那次失败）→ 摘要必须提词，不许借绿带过", () => {
    const s = summarize(mkAudit([
      { id: "self-proof", name: "自证（verify）", state: "fresh", count: 1, detail: "", code: "", flags: ["最后一条自证是失败的（自证未过：deps 失败）"] },
    ]));
    assert.match(s.line, /提词/);
    assert.match(s.line, /自证/);
    assert.match(s.line, /失败/);
    assert.equal(s.flags.length, 1);
    assert.equal(s.ok, true, "状态仍是绿（确实跑过），但话必须说到");
  });

  test("红项带一句'下一步查哪'，不让人对着红灯发呆", () => {
    const s = summarize(mkAudit([{ id: "growth", name: "成长", state: "never", count: 0, detail: "", code: "engine/genome-growth.mjs" }]));
    assert.match(s.issues[0].look, /genome-growth/);
  });

  test("处置建议按 cadence 给不同的话：轮末驱动先看有没有聊过，后台驱动直接怀疑被挡", () => {
    const turn = summarize(mkAudit([{ id: "a", name: "甲", state: "never", count: 0, detail: "", code: "", cadence: "turn" }]));
    assert.match(turn.issues[0].look, /对话轮驱动/);
    assert.match(turn.issues[0].look, /正常的/);
    const bg = summarize(mkAudit([{ id: "b", name: "乙", state: "never", count: 0, detail: "", code: "", cadence: "background" }]));
    assert.match(bg.issues[0].look, /后台定时驱动/);
    assert.match(bg.issues[0].look, /策略层/);
    const manual = summarize(mkAudit([{ id: "c", name: "丙", state: "never", count: 0, detail: "", code: "", cadence: "manual" }]));
    assert.match(manual.issues[0].look, /手动驱动/);
  });
});

describe("CLI 与退出码", () => {
  test("--stale-days 两种写法都认", () => {
    assert.deepEqual(parseArgs(["--stale-days", "3"]).thresholds, { default: 3 * DAY });
    assert.deepEqual(parseArgs(["--stale-days", "growth=90"]).thresholds, { growth: 90 * DAY });
    assert.equal(parseArgs(["--stale-days", "abc"]).error !== "", true);
    assert.equal(parseArgs(["--nope"]).error !== "", true);
  });

  test("--root / --json / --strict", () => {
    const cfg = parseArgs(["--root", "D:\\tmp", "--json", "--strict"]);
    assert.equal(cfg.root, "D:\\tmp");
    assert.equal(cfg.json, true);
    assert.equal(cfg.strict, true);
    assert.equal(cfg.error, "");
  });

  test("有 never/stale → exit 2；只有 unknown → 0；--strict 下 unknown 也 2", () => {
    assert.equal(exitCodeFor({ counts: { fresh: 3, stale: 0, never: 0, unknown: 0 } }), 0);
    assert.equal(exitCodeFor({ counts: { fresh: 0, stale: 1, never: 0, unknown: 0 } }), 2);
    assert.equal(exitCodeFor({ counts: { fresh: 0, stale: 0, never: 1, unknown: 0 } }), 2);
    assert.equal(exitCodeFor({ counts: { fresh: 0, stale: 0, never: 0, unknown: 4 } }), 0);
    assert.equal(exitCodeFor({ counts: { fresh: 0, stale: 0, never: 0, unknown: 4 } }, true), 2);
  });

  test("表格有表头且把判据列写出来（只看状态不知道凭什么判的）", () => {
    const ws = mkWs();
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    writeJsonl(ws, "记忆/运行时/探针.jsonl", [{ at: now }]);
    const audit = auditVitality({ wsRoot: ws, now, mechanisms: one({ criterion: "≤3 天" }) });
    const table = renderTable(audit);
    for (const col of ["机制", "状态", "最后产出", "计数", "判据"]) assert.ok(table.includes(col), `表头缺 ${col}`);
    assert.match(table, /新鲜/);
  });
});

describe("小工具", () => {
  test("pick 点分取值，路径断了返回 undefined", () => {
    assert.equal(pick({ a: { b: 1 } }, "a.b"), 1);
    assert.equal(pick({ a: null }, "a.b"), undefined);
    assert.equal(pick({}, ""), undefined);
  });

  test("globMatchName 只支持一个 *，够用就行", () => {
    assert.ok(globMatchName("遗忘报告-2026-11-09.md", "遗忘报告-*.md"));
    assert.ok(!globMatchName("遗忘报告.md", "遗忘报告-*.md"));
    assert.ok(globMatchName("x.md", "x.md"));
  });

  test("rowMatches 的三种匹配方式", () => {
    assert.ok(rowMatches({ s: "event:happy" }, { field: "s", prefix: "event:" }));
    assert.ok(rowMatches({ t: "verify_check" }, { field: "t", equals: "verify_check" }));
    assert.ok(!rowMatches({ t: "bash" }, { field: "t", equals: "verify_check" }));
    assert.ok(rowMatches({ a: 1 }, null), "没给 match 就是全都要");
  });

  test("humanAge / formatTime 不崩且给人话", () => {
    assert.equal(humanAge(-1), "刚刚");
    assert.match(humanAge(3 * DAY), /天/);
    assert.equal(formatTime(NaN), "—");
    assert.match(formatTime(Date.now()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
