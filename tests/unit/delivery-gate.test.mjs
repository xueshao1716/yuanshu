// 交付门：证据抽取与 GREEN/YELLOW/RED 判定（2026-10-31）
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEvidence, judgeDelivery, describeVerdict, pathOfRow, CHANGE_TOOLS } from "../../engine/delivery-gate.mjs";

const rows = [
  { at: 1000, phase: "before", tool: "write", argsPreview: '{"path":"src/a.mjs","content":"x"}' },
  { at: 1001, phase: "after", tool: "write", ok: true },
  { at: 2000, phase: "before", tool: "bash", argsPreview: '{"command":"node --test tests/a.test.mjs"}' },
  { at: 2500, phase: "after", tool: "bash", ok: true },
];

test("改动 + 之后有验证 → GREEN", () => {
  const r = judgeDelivery({ rows });
  assert.equal(r.verdict, "GREEN");
  assert.deepEqual(r.covered, ["src/a.mjs"]);
  assert.deepEqual(r.uncovered, []);
});

test("改动发生在验证之后 → 未覆盖 → RED", () => {
  const r = judgeDelivery({ rows: [...rows, { at: 3000, phase: "before", tool: "edit", argsPreview: '{"path":"src/b.mjs"}' }] });
  assert.equal(r.verdict, "RED");
  assert.deepEqual(r.uncovered, ["src/b.mjs"]);
  assert.match(r.reasons.join(" "), /没被验证覆盖/);
});

test("验证失败 → RED，并能说出是验证没过", () => {
  const r = judgeDelivery({ rows: [...rows, { at: 2600, phase: "after", tool: "bash", ok: false, error: "1 test failed", argsPreview: '{"command":"node --test"}' }] });
  assert.equal(r.verdict, "RED");
  assert.match(r.reasons.join(" "), /验证没通过/);
});

test("命令执行失败也算 RED", () => {
  const r = judgeDelivery({ rows: [...rows, { at: 2700, phase: "after", tool: "bash", ok: false, error: "ENOENT" }] });
  assert.equal(r.verdict, "RED");
  assert.match(r.reasons.join(" "), /命令执行失败/);
});

test("全部覆盖但有外部阻塞 → YELLOW，并写出条件", () => {
  const r = judgeDelivery({ rows, blockers: ["发布要等伙伴点头"] });
  assert.equal(r.verdict, "YELLOW");
  assert.match(r.conditions.join(" "), /等伙伴点头/);
});

test("声明已验证但没记录 → 仍算覆盖，但标条件", () => {
  const r = judgeDelivery({ rows: [{ at: 1, phase: "before", tool: "write", argsPreview: '{"path":"a.md"}' }], verified: ["a.md"] });
  assert.equal(r.verdict, "YELLOW");
  assert.deepEqual(r.covered, ["a.md"]);
  assert.match(r.conditions.join(" "), /声明已验证/);
});

test("只读工具不算改动", () => {
  const r = judgeDelivery({ rows: [
    { at: 1, phase: "before", tool: "read", argsPreview: '{"path":"a.md"}' },
    { at: 2, phase: "after", tool: "read", ok: true },
  ] });
  assert.equal(r.verdict, "GREEN");
  assert.deepEqual(r.covered, []);
});

test("extractEvidence：认出改动 / 验证 / 失败三类", () => {
  const e = extractEvidence([
    { at: 10, phase: "before", tool: "write", argsPreview: '{"path":"x.mjs"}' },
    { at: 20, phase: "before", tool: "bash", argsPreview: '{"command":"npm run build"}' },
    { at: 30, phase: "after", tool: "bash", ok: true, argsPreview: '{"command":"npm run build"}' },
    { at: 40, phase: "after", tool: "bash", ok: false, error: "boom" },
  ]);
  assert.equal(e.changes.get("x.mjs"), 10);
  assert.equal(e.verifications.length, 2, "成功和失败的验证都要记（失败的那次用来判 RED）");
  assert.equal(e.verifications.filter((v) => v.ok).length, 1);
  assert.equal(e.failures.length, 1);
});

test("pathOfRow 能从截断的预览里抠路径", () => {
  assert.equal(pathOfRow({ argsPreview: '{"path":"记忆/人格定义.json","content":"很长很长的内容"' }), "记忆/人格定义.json");
  assert.equal(pathOfRow({ argsPreview: '{"command":"ls"}' }), "");
});

test("describeVerdict 说人话", () => {
  assert.match(describeVerdict({ verdict: "GREEN" }), /可以交付/);
  assert.match(describeVerdict({ verdict: "RED", reasons: ["2 次命令执行失败"] }), /不能交付/);
  assert.match(describeVerdict({ verdict: "YELLOW", conditions: ["等伙伴点头"] }), /有条件/);
});

test("CHANGE_TOOLS 覆盖写文件的常见工具名", () => {
  for (const t of ["write", "edit", "apply_patch"]) assert.ok(CHANGE_TOOLS.has(t), t);
});

test('脚本里跑测试：命令看不出关键字，但输出有 passed 也算验证', () => {
  const r = judgeDelivery({ rows: [
    { at: 10, phase: 'before', tool: 'write', argsPreview: JSON.stringify({ path: 'src/x.mjs' }) },
    { at: 20, phase: 'before', tool: 'bash', argsPreview: JSON.stringify({ command: 'node scripts/run-all.mjs' }) },
    { at: 30, phase: 'after', tool: 'bash', ok: true, resultPreview: '48 passed, 0 failed' },
  ] });
  assert.equal(r.verdict, 'GREEN');
  assert.deepEqual(r.covered, ['src/x.mjs']);
});

test('脚本输出没有测试结果 → 仍算未覆盖', () => {
  const r = judgeDelivery({ rows: [
    { at: 10, phase: 'before', tool: 'write', argsPreview: JSON.stringify({ path: 'src/x.mjs' }) },
    { at: 20, phase: 'before', tool: 'bash', argsPreview: JSON.stringify({ command: 'node scripts/run-all.mjs' }) },
    { at: 30, phase: 'after', tool: 'bash', ok: true, resultPreview: 'done.' },
  ] });
  assert.equal(r.verdict, 'RED');
  assert.deepEqual(r.uncovered, ['src/x.mjs']);
});

// 2026-11-08：RED 不许只回一句"不能交付"。
// 真事故里日志只有「13 次命令执行失败；8 个改动文件没被验证覆盖；未覆盖：a、b、c…」，
// 既看不到失败的是哪条命令、输出是什么，也不知道未覆盖的到底有几个。
test('RED 结构化：失败命令数 + 前 3 条命令与输出摘要（各 ≤120 字）', () => {
  const longOutput = 'E'.repeat(300);
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push({ at: 10 + i * 100, phase: 'before', tool: 'bash', argsHash: `h${i}`, argsPreview: JSON.stringify({ command: `npm test -- case-${i}` }) });
    rows.push({ at: 11 + i * 100, phase: 'after', tool: 'bash', argsHash: `h${i}`, ok: false, error: 'exit 1', resultPreview: i === 0 ? longOutput : `Error ${i}` });
  }
  const r = judgeDelivery({ rows });
  assert.equal(r.verdict, 'RED');
  assert.equal(r.failedChecks.length, 5);
  assert.equal(r.failedCommands.length, 3, '只带前 3 条，不是把 13 条全塞回去');
  assert.equal(r.failedCount, 5);
  assert.equal(r.failedCommands[0].command, 'npm test -- case-0');
  assert.ok(r.failedCommands[0].output.length <= 120, '输出摘要要截断到 120 字');
  const s = describeVerdict(r);
  assert.match(s, /^不能交付：5 次命令执行失败/);
  assert.match(s, /失败命令（共 5 次，前 3 条）/);
  assert.match(s, /1\. npm test -- case-0 → E{10}/);
  assert.ok(s.split('\n').length >= 4, '要分行列出，不是一行糊着');
});

test('RED 结构化：未覆盖文件只列前 5 个，但给出总数', () => {
  const rows = [];
  for (let i = 0; i < 7; i++) {
    rows.push({ at: 10 + i, phase: 'before', tool: 'write', argsPreview: JSON.stringify({ path: `src/file-${i}.mjs` }) });
  }
  const r = judgeDelivery({ rows });
  assert.equal(r.verdict, 'RED');
  assert.equal(r.uncoveredTotal, 7);
  const s = describeVerdict(r);
  assert.match(s, /未覆盖文件（共 7 个，前 5 个）：/);
  assert.match(s, /src\/file-0\.mjs/);
  assert.ok(s.includes('src/file-4.mjs'));
  assert.ok(!s.includes('src/file-5.mjs'), '第 6 个不列，只给总数');
});
