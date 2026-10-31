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
