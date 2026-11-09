// 反模式台账（2026-11-09）：解析/校验、匹配、三类自动检测、命中升级、prompt 去重注入。
// 锁住的是行为边界，不是文案：阈值（3 次 / 10 分钟 / 2 条注入）改之前先来改这里。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LEDGER_REL, HIT_REL, SEVERITIES, PROMPT_PREFIX, INJECT_LIMIT,
  DEFAULT_PATTERNS, SAME_ARGS_THRESHOLD, RETRY_THRESHOLD, RETRY_WINDOW_MS, ESCALATE_AFTER,
  ANTI_PATTERN_CHECK_TOOL,
  normalizePattern, validatePattern, validateLedger, normalizeSeverity, statsOf,
  loadAntiPatterns, ensureLedger, saveLedger, filePath, hitFilePath,
  matchAntiPatterns, promptBlock, alreadyInjected, antiPatternPromptLine,
  detectViolations, promiseClause, recordViolation, runAntiPatternCheck, init,
} from "../../engine/anti-patterns.mjs";

const SOURCE_FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "linxinyu-anti_patterns.json");
const readSource = () => JSON.parse(fs.readFileSync(SOURCE_FIXTURE, "utf8"));

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "anti-patterns-"));
const ledgerPath = (root) => path.join(root, LEDGER_REL);
const hitPath = (root) => path.join(root, HIT_REL);
const hitLines = (root) => fs.readFileSync(hitPath(root), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// 事件构造器：默认时间固定，需要顺序时显式传 at。
const toolEvent = (name, args, extra = {}) => ({
  at: "2026-11-09T10:00:00.000Z", type: "tool", name, args, ok: true, ...extra,
});
const failEvent = (command, at, extra = {}) => toolEvent("bash", { command }, { at, ok: false, error: "boom", ...extra });
const sayEvent = (text, at = "2026-11-09T10:00:00.000Z", extra = {}) => ({ at, type: "assistant", text, ...extra });

describe("源记录解析与字段校验", () => {
  test("林心语 7 条源记录全部能解析成台账条目", () => {
    const src = readSource();
    assert.equal(src.patterns.length, 7);
    const parsed = src.patterns.map((p) => normalizePattern(p, { source: "林心语 anti_patterns.json" }));
    assert.equal(parsed.length, 7);
    for (const p of parsed) {
      assert.doesNotThrow(() => validatePattern(p), `${p.id} 字段不全`);
      assert.ok(SEVERITIES.includes(p.severity), `${p.id} severity 不在枚举里`);
      assert.ok(p.trigger.kind, `${p.id} 没有 trigger.kind`);
      assert.ok(p.trigger.detect, `${p.id} 没有 trigger.detect（源 auto_trigger）`);
      assert.ok(p.remedy.length > 4, `${p.id} remedy 太短`);
      assert.match(p.discoveredAt, /^\d{4}-\d{2}-\d{2}/, `${p.id} 日期丢了`);
      assert.equal(p.source, "林心语 anti_patterns.json");
    }
    // 源里 critical/high 折成 high（元枢只有三档），medium 原样。
    assert.equal(normalizeSeverity("critical"), "high");
    assert.equal(parsed.filter((p) => p.severity === "high").length, 5);
    assert.equal(parsed.filter((p) => p.severity === "medium").length, 2);
  });

  test("缺 remedy 直接报错（没有改法的条目不许进台账）", () => {
    const src = readSource();
    const bad = { ...src.patterns[0] };
    delete bad.remedy;
    assert.throws(() => normalizePattern(bad), /remedy/);
  });

  test("缺 id / 缺 symptom / 缺日期 / 非法 severity 各自报错", () => {
    const src = readSource();
    const base = src.patterns[0];
    assert.throws(() => normalizePattern({ ...base, id: "" }), /缺少 id/);
    assert.throws(() => normalizePattern({ ...base, description: "" }), /symptom/);
    assert.throws(() => normalizePattern({ ...base, added: "" }), /discoveredAt/);
    assert.throws(() => normalizePattern({ ...base, severity: "blocker" }), /severity/);
    assert.throws(() => validatePattern({ ...base, title: "" }), /缺少 title/);
  });

  test("内置台账 11 条、id 唯一、每条 remedy 都是可执行句而不是提醒", () => {
    const list = loadAntiPatterns(path.join(os.tmpdir(), `ap-none-${Date.now()}`));
    assert.equal(list.length, 11);
    assert.equal(new Set(list.map((p) => p.id)).size, 11);
    assert.doesNotThrow(() => validateLedger(list));
    assert.deepEqual(statsOf(list), { total: 11, high: 8, medium: 3, low: 0 });
    for (const p of list) {
      assert.ok(Array.isArray(p.examples), `${p.id} examples 不是数组`);
      assert.ok(p.examples.every((x) => typeof x === "string"), `${p.id} examples 里有非字符串`);
      // "要小心/注意"式 remedy 在 prompt 里等于噪声：至少得有一个动作词。
      assert.match(p.remedy, /(先|再|就|读|跑|查|看|比|换|停|只|别|报|写|扫|用)/, `${p.id} remedy 不像可执行句：${p.remedy}`);
    }
  });
});

describe("台账落盘（默认 dry-run）", () => {
  test("ensureLedger 默认 dry-run：只返回 preview，不写文件", () => {
    const root = tmpRoot();
    const r = ensureLedger(root);
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(fs.existsSync(ledgerPath(root)), false);
    const doc = JSON.parse(r.text);
    assert.equal(doc.patterns.length, 11);
    assert.equal(doc.stats.total, 11);
  });

  test("dryRun:false 才落盘，loadAntiPatterns 读得回来", () => {
    const root = tmpRoot();
    const r = ensureLedger(root, { dryRun: false });
    assert.equal(r.created, true);
    assert.equal(fs.existsSync(ledgerPath(root)), true);
    const list = loadAntiPatterns(root, { fresh: true });
    assert.equal(list.length, 11);
    assert.equal(list[0].id, "AP-001");
    assert.equal(statsOf(list).high, 8);
  });

  test("台账坏了明确报错，不静默回落成内置（静默回落=无人察觉）", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "记忆"), { recursive: true });
    fs.writeFileSync(ledgerPath(root), "{ 这不是 json", "utf8");
    assert.throws(() => loadAntiPatterns(root, { fresh: true }), /反模式台账读不了/);
  });
});

describe("匹配：按场景关键词/工具名/失败类型", () => {
  test("报数场景：命中 2 条，最相关在前，顺序稳定", () => {
    const ctx = { text: "跑测试，一共多少项通过" };
    const a = matchAntiPatterns(ctx, { limit: 2 });
    const b = matchAntiPatterns(ctx, { limit: 2 });
    assert.deepEqual(a.map((p) => p.id), ["AP-009", "AP-011"]);
    assert.deepEqual(a.map((p) => p.id), b.map((p) => p.id));
    assert.ok(a[0].score > a[1].score, "分数没拉开，排序就不稳");
  });

  test("工具名能直接命中：fix_problem → 观察任务那条排第一", () => {
    const hits = matchAntiPatterns({ tools: ["fix_problem"] }, { limit: 2 });
    assert.equal(hits[0].id, "AP-008");
    assert.deepEqual(hits[0].matched, ["tool:fix_problem"]);
  });

  test("交付场景：生成物厂商 URL 排在观察任务前面", () => {
    const hits = matchAntiPatterns({ text: "交付生成的图，顺便看一眼有没有水印", tools: ["generate_image"] }, { limit: 2 });
    assert.deepEqual(hits.map((p) => p.id), ["AP-010", "AP-008"]);
  });

  test("limit 生效且不超过上限；无关场景零匹配", () => {
    const wide = { text: "交付图片视频，跑测试报数，部署上线盖章，fix_problem，再看一眼" };
    assert.ok(matchAntiPatterns(wide, { limit: 3 }).length <= 3);
    assert.equal(matchAntiPatterns(wide, { limit: 3 }).length, 3);
    assert.deepEqual(matchAntiPatterns({ text: "今天天气不错，适合散步" }), []);
    assert.deepEqual(matchAntiPatterns({}), []);
  });

  test("失败类型能命中死循环重试", () => {
    const hits = matchAntiPatterns({ errors: ["timeout"] }, { limit: 1 });
    assert.equal(hits[0].id, "AP-003");
  });

  test("传空台账就是空匹配（不自作主张回落到内置）", () => {
    assert.deepEqual(matchAntiPatterns({ text: "跑测试" }, { patterns: [] }), []);
    assert.equal(antiPatternPromptLine({ text: "跑测试" }, { patterns: [] }), "");
  });
});

describe("prompt 注入：只 2 行、无匹配零注入、同块去重", () => {
  const patterns = loadAntiPatterns(path.join(os.tmpdir(), `ap-none-${Date.now()}`));

  test("有匹配：最多 2 行，每行都是「⚠ 别：… → 该：…」", () => {
    const block = antiPatternPromptLine({ text: "跑测试，一共多少项通过" }, { patterns });
    assert.ok(block.startsWith(PROMPT_PREFIX));
    const lines = block.split("\n");
    assert.equal(lines.length, INJECT_LIMIT);
    for (const line of lines) {
      assert.match(line, /⚠ 别：.+ → 该：.+/);
    }
    assert.equal(block.match(/反模式：/g).length, 1, "前缀只出现一次");
  });

  test("无匹配：返回空串（零成本，不占上下文）", () => {
    assert.equal(antiPatternPromptLine({ text: "今天天气不错，适合散步" }, { patterns }), "");
  });

  test("历史里已有同一块就不再注入，且块里前缀只出现一次", () => {
    const block = antiPatternPromptLine({ text: "跑测试，一共多少项通过" }, { patterns });
    const history = [{ role: "user", content: "跑下测试" }, { role: "system", content: `${block}` }];
    assert.equal(alreadyInjected(history), true);
    const next = alreadyInjected(history) ? "" : block;
    assert.equal(next, "");
    assert.equal((history[1].content.match(/反模式：/g) || []).length, 1);
    assert.equal(alreadyInjected([{ role: "system", content: "情绪语境…人格漂移：…成长：" }]), false);
    assert.equal(alreadyInjected([]), false);
  });
});

describe("自动检测一：同参数工具连续调用", () => {
  test("3 次同参命中，2 次不命中（边界）", () => {
    const three = detectViolations([toolEvent("read", { path: "a" }), toolEvent("read", { path: "a" }), toolEvent("read", { path: "a" })]);
    assert.equal(three.length, 1);
    assert.equal(three[0].id, "AP-001");
    const two = detectViolations([toolEvent("read", { path: "a" }), toolEvent("read", { path: "a" })]);
    assert.deepEqual(two, []);
    assert.equal(SAME_ARGS_THRESHOLD, 3);
  });

  test("参数不同交替不算循环；两组各自 3 次各报一次", () => {
    const alternating = [
      toolEvent("read", { path: "a" }), toolEvent("read", { path: "b" }),
      toolEvent("read", { path: "a" }), toolEvent("read", { path: "b" }),
    ];
    assert.deepEqual(detectViolations(alternating), []);
    const twoRuns = [
      toolEvent("read", { path: "a" }), toolEvent("read", { path: "a" }), toolEvent("read", { path: "a" }),
      toolEvent("grep", { q: "x" }), toolEvent("grep", { q: "x" }), toolEvent("grep", { q: "x" }),
    ];
    const hits = detectViolations(twoRuns);
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.id), ["AP-001", "AP-001"]);
  });

  test("参数键顺序不同视为同一参数（不会因为 key 顺序漏判）", () => {
    const hits = detectViolations([
      toolEvent("read", { a: 1, b: 2 }), toolEvent("read", { b: 2, a: 1 }), toolEvent("read", { a: 1, b: 2 }),
    ]);
    assert.equal(hits.length, 1);
  });
});

describe("自动检测二：同一失败命令重试", () => {
  const T0 = "2026-11-09T10:00:00.000Z";
  const at = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();

  test("10 分钟内失败 3 次命中", () => {
    const hits = detectViolations([failEvent("npm test", at(0)), failEvent("npm test", at(2)), failEvent("npm test", at(4))]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "AP-003");
    assert.match(hits[0].evidence, /失败命令重试 3 次/);
    assert.equal(RETRY_THRESHOLD, 3);
    assert.equal(RETRY_WINDOW_MS, 600_000);
  });

  test("跨 10 分钟窗口不命中", () => {
    const hits = detectViolations([failEvent("npm test", at(0)), failEvent("npm test", at(6)), failEvent("npm test", at(12))]);
    assert.deepEqual(hits, []);
  });

  test("中间成功过一次就清空连续失败", () => {
    const hits = detectViolations([
      failEvent("npm test", at(0)),
      toolEvent("bash", { command: "npm test" }, { at: at(1), ok: true }),
      failEvent("npm test", at(2)),
      failEvent("npm test", at(3)),
    ]);
    assert.deepEqual(hits, []);
  });

  test("不同命令不合并计数", () => {
    const hits = detectViolations([failEvent("npm test", at(0)), failEvent("npm run build", at(1)), failEvent("npm test", at(2))]);
    assert.deepEqual(hits, []);
  });
});

describe("自动检测三：空头承诺", () => {
  test("承诺「我接下来会跑」但本轮无工具调用 → 命中", () => {
    const hits = detectViolations([sayEvent("我接下来会跑一遍测试，然后告诉你结果")]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "AP-006");
    assert.match(hits[0].evidence, /承诺「我接下来会跑」/);
    assert.equal(promiseClause("我接下来会跑一遍测试"), "我接下来会跑");
  });

  test("同一个 turn 里有工具调用 → 不命中", () => {
    const hits = detectViolations([
      sayEvent("我接下来会跑一遍测试", "2026-11-09T10:00:00.000Z", { turn: 3 }),
      { at: "2026-11-09T10:00:01.000Z", type: "tool", name: "bash", args: { command: "npm test" }, turn: 3, ok: true },
    ]);
    assert.deepEqual(hits, []);
  });

  test("过去式和一般陈述不算承诺", () => {
    assert.deepEqual(detectViolations([sayEvent("我看了下截图，里面没有这个人")]), []);
    assert.deepEqual(detectViolations([sayEvent("我会注意语气")]), []);
    assert.equal(promiseClause("我看了下截图"), "");
    assert.equal(promiseClause("我会注意语气"), "");
  });

  test("跨 turn 的工具调用不能替下一轮的承诺作证", () => {
    const hits = detectViolations([
      sayEvent("我接下来会核对数量", "2026-11-09T10:00:00.000Z", { turn: 1 }),
      { at: "2026-11-09T10:00:02.000Z", type: "tool", name: "verify_check", args: {}, turn: 2, ok: true },
    ]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "AP-006");
  });

  test("命中形状统一：{id, evidence, at} 且 at 是 ISO", () => {
    const hits = detectViolations([
      toolEvent("read", { path: "a" }), toolEvent("read", { path: "a" }), toolEvent("read", { path: "a" }),
    ]);
    assert.deepEqual(Object.keys(hits[0]).sort(), ["at", "evidence", "id"]);
    assert.equal(new Date(hits[0].at).toISOString(), hits[0].at);
    assert.ok(hits[0].evidence.length > 4);
  });
});

describe("命中落盘与连续升级", () => {
  const seedLedger = (root) => {
    const list = loadAntiPatterns(path.join(os.tmpdir(), `ap-none-${Date.now()}`));
    list.find((p) => p.id === "AP-001").severity = "medium";
    saveLedger(root, list);
  };
  const hit = { id: "AP-001", evidence: "同参调用 read 3 次（{\"path\":\"a\"}）", at: "2026-11-09T10:00:00.000Z" };

  test("每次命中追加一行 jsonl，前 2 次不升级", () => {
    const root = tmpRoot();
    seedLedger(root);
    const r1 = recordViolation(root, hit);
    const r2 = recordViolation(root, hit);
    assert.equal(r1.ok, true);
    assert.equal(r1.count, 1);
    assert.equal(r2.count, 2);
    assert.equal(r2.escalated, null);
    assert.equal(hitLines(root).length, 2);
    assert.equal(hitLines(root)[0].id, "AP-001");
    assert.equal(hitLines(root)[0].at, hit.at);
    assert.ok(hitLines(root)[0].recordedAt);
  });

  test("连续第 3 次命中把 severity 升一档并写回台账", () => {
    const root = tmpRoot();
    seedLedger(root);
    recordViolation(root, hit);
    recordViolation(root, hit);
    const r3 = recordViolation(root, hit);
    assert.equal(r3.count, ESCALATE_AFTER);
    assert.deepEqual(r3.escalated, { from: "medium", to: "high", capped: false });
    const saved = JSON.parse(fs.readFileSync(ledgerPath(root), "utf8"));
    assert.equal(saved.patterns.find((p) => p.id === "AP-001").severity, "high");
    assert.equal(saved.stats.high, 8);
    assert.equal(saved.stats.medium, 3);
  });

  test("中间夹了别的命中，连续计数被打断", () => {
    const root = tmpRoot();
    seedLedger(root);
    recordViolation(root, hit);
    recordViolation(root, hit);
    recordViolation(root, { id: "AP-003", evidence: "失败命令重试 3 次", at: hit.at });
    recordViolation(root, hit);
    const r = recordViolation(root, hit);
    assert.equal(r.count, 2);
    assert.equal(r.escalated, null);
  });

  test("到 high 就封顶：继续命中提示 capped，不再升级", () => {
    const root = tmpRoot();
    seedLedger(root);
    for (let i = 0; i < 3; i += 1) recordViolation(root, hit);
    recordViolation(root, hit);
    recordViolation(root, hit);
    const r6 = recordViolation(root, hit);
    assert.equal(r6.count, 6);
    assert.deepEqual(r6.escalated, { from: "high", to: "high", capped: true });
    assert.equal(JSON.parse(fs.readFileSync(ledgerPath(root), "utf8")).patterns.find((p) => p.id === "AP-001").severity, "high");
  });

  test("dryRun 不写 jsonl；没有台账文件时不凭空建档", () => {
    const root = tmpRoot();
    const r = recordViolation(root, hit, { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(hitPath(root)), false);
    const root2 = tmpRoot();
    for (let i = 0; i < 3; i += 1) recordViolation(root2, hit);
    assert.equal(fs.existsSync(ledgerPath(root2)), false, "没有台账就不该被升级逻辑创建");
    assert.equal(hitLines(root2).length, 3);
  });

  test("缺 id / 缺 evidence 直接拒绝", () => {
    const root = tmpRoot();
    assert.equal(recordViolation(root, { evidence: "x" }).ok, false);
    assert.equal(recordViolation(root, { id: "AP-001" }).ok, false);
    assert.equal(recordViolation("", hit).ok, false);
    assert.equal(fs.existsSync(hitPath(root)), false);
  });
});

describe("主动查：anti_pattern_check", () => {
  const root = tmpRoot();
  const patterns = loadAntiPatterns(path.join(os.tmpdir(), `ap-none-${Date.now()}`));

  test("给 context 返回匹配条目全文（症状/该/判定/例）", () => {
    const out = runAntiPatternCheck({ wsRoot: root, context: "交付图片，看一眼有没有水印", limit: 2 });
    assert.equal(out.isError, false);
    assert.match(out.text, /反模式对照：匹配 \d 条/);
    assert.match(out.text, /症状：/);
    assert.match(out.text, /该：/);
    assert.match(out.text, /AP-010/);
  });

  test("不给 context 返回索引，不把全文倒进上下文", () => {
    const out = runAntiPatternCheck({ wsRoot: root });
    assert.equal(out.isError, false);
    assert.match(out.text, /反模式台账：11 条/);
    assert.match(out.text, /AP-001 \[high\]/);
    assert.doesNotMatch(out.text, /症状：/, "索引不该带全文");
  });

  test("台账坏了返回 isError，而不是给一份缺条目的清单", () => {
    const bad = tmpRoot();
    fs.mkdirSync(path.join(bad, "记忆"), { recursive: true });
    fs.writeFileSync(ledgerPath(bad), "{坏", "utf8");
    const out = runAntiPatternCheck({ wsRoot: bad, context: "跑测试" });
    assert.equal(out.isError, true);
    assert.match(out.text, /读不了/);
  });

  test("内置台账可直接用于索引（没有工作区也能回答）", () => {
    const out = runAntiPatternCheck({ wsRoot: root, context: "" });
    assert.match(out.text, new RegExp(`反模式台账：${patterns.length} 条`));
  });
});

describe("接线：两条引擎入口都挂上了", () => {
  const ROOT = path.join(import.meta.dirname, "..", "..");
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

  test("工具定义：名字/参数/默认条数", () => {
    assert.equal(ANTI_PATTERN_CHECK_TOOL.type, "function");
    assert.equal(ANTI_PATTERN_CHECK_TOOL.function.name, "anti_pattern_check");
    assert.deepEqual(Object.keys(ANTI_PATTERN_CHECK_TOOL.function.parameters.properties).sort(), ["context", "limit"]);
    assert.deepEqual(ANTI_PATTERN_CHECK_TOOL.function.parameters.required, []);
    assert.match(ANTI_PATTERN_CHECK_TOOL.function.description, /不是门禁/);
  });

  test("统一引擎：UNIFIED_TOOLS、执行器表、导入顺序", () => {
    const src = read("server.mjs");
    const start = src.indexOf("const UNIFIED_TOOLS = [");
    assert.ok(start > 0, "找不到 UNIFIED_TOOLS");
    const end = src.indexOf("\n];", start);
    assert.ok(end > start, "找不到 UNIFIED_TOOLS 的收尾");
    assert.match(src.slice(start, end), /^\s*ANTI_PATTERN_CHECK_TOOL,\s*$/m, "必须进 UNIFIED_TOOLS");

    const exStart = src.indexOf("const extraToolExecutors = {");
    assert.ok(exStart > 0, "找不到执行器表 extraToolExecutors");
    const exEnd = src.indexOf("\n};", exStart);
    const table = src.slice(exStart, exEnd);
    assert.match(table, /^\s*anti_pattern_check:\s*\(args\)\s*=>/m, "执行器表里必须有 anti_pattern_check");
    assert.match(table, /wsRoot:\s*CONFIG\.cwd/, "取工作区台账，不是仓库里的");

    assert.match(src, /import\s*\{[^}]*ANTI_PATTERN_CHECK_TOOL[^}]*\}\s*from\s*["']\.\/engine\/anti-patterns\.mjs["']/);
    assert.ok(src.indexOf("import { ANTI_PATTERN_CHECK_TOOL") < start, "导入必须早于 UNIFIED_TOOLS");
  });

  test("Pi 通道：tool-inits 有定义，manager 挂上", () => {
    const inits = read("engine", "session", "tool-inits.mjs");
    assert.match(inits, /async function initAntiPatternTool\(\)/);
    assert.match(inits, /name:\s*["']anti_pattern_check["']/);
    assert.match(inits, /initAntiPatternTool,/);
    const manager = read("engine", "session", "manager.mjs");
    assert.match(manager, /initAntiPatternTool/);
    assert.match(manager, /customTools\.push\(antiPatternTool\)/);
  });

  test("收轮检测：unified-chat 在 finishEmotion 里扫一遍，只写 jsonl", () => {
    const src = read("engine", "unified-chat.mjs");
    assert.match(src, /import \{ detectViolations, recordViolation \} from "\.\/anti-patterns\.mjs"/);
    assert.match(src, /const scanTurnAntiPatterns = \(\) => \{/);
    assert.match(src, /recordViolation\(_cwd, hit\)/);
    assert.match(src, /try \{ scanTurnAntiPatterns\(\); \} catch \{\}/);
    assert.match(src, /if \(antiPatternScanned\) return;/, "一轮只扫一次，别在多个 return 分支重复记");
    // 检测采样只留工具名/参数/成败，不把工具输出正文抄进 jsonl
    assert.match(src, /antiPatternEvents\.push\(\{ at: new Date\(\)\.toISOString\(\), type: "tool", name, args, ok: out\?\.isError !== true/);
  });

  test("注入：与漂移/成长同一个 system 块，且用去重前缀", () => {
    const src = read("engine", "yuanshu-emotion.mjs");
    assert.match(src, /antiPatternPromptLine/);
    assert.match(src, /alreadyInjected\(history\)/);
    // 反模式仍是同一块里的并列行；后面可以再接别的行（2026-11-09 接的是复习），但顺序不能挪到 prompt 之前。
    assert.match(src, /\[prompt, relationshipLine\(\), genomeLine\(\), growthLine\(\), antiPatternLine\(msg, context\)/);
    // 工作区根绑定在 emotion.init 里，和 genome/growth 同一处
    const emo = read("engine", "emotion.mjs");
    assert.match(emo, /initAntiPatterns\(wsRoot\)/);
    assert.match(emo, /from "\.\/anti-patterns\.mjs"/);
  });
});

describe("工作区绑定", () => {
  test("init 之后 antiPatternPromptLine 读盘生效，换根后互不串", () => {
    const root = tmpRoot();
    ensureLedger(root, { dryRun: false });
    init(root);
    const line = antiPatternPromptLine({ text: "跑测试，一共多少项通过" });
    assert.ok(line.startsWith(PROMPT_PREFIX));
    assert.equal(line.split("\n").length, 2);
    init("");
    assert.equal(antiPatternPromptLine({ text: "跑测试，一共多少项通过" }), antiPatternPromptLine({ text: "跑测试，一共多少项通过" }));
    assert.equal(filePath(root), ledgerPath(root));
    assert.equal(hitFilePath(root), hitPath(root));
  });
});
