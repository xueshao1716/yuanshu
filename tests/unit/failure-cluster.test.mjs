// 失败聚类：签名归一 / 阈值 / 提案转换（2026-11-03）
import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterFailures, signatureOf, toProposalInput } from "../../engine/learning/failure-cluster.mjs";

const now = Date.parse("2026-11-03T18:00:00");
const ev = (verdict, o = {}) => ({ kind: "gate", at: new Date(now - 3600_000).toISOString(), verdict, taskType: "coding", target: "delivery", targetId: "run1", ...o });

test("签名归一：路径/数字/哈希被抹平", () => {
  const a = signatureOf({ verdict: "red", meta: { blockers: [{ message: "D:\\pi-web\\engine\\x.mjs 第 12 行 失败 abc123def" }] } });
  const b = signatureOf({ verdict: "red", meta: { blockers: [{ message: "D:\\pi-web\\engine\\y.mjs 第 99 行 失败 999aaabbb" }] } });
  assert.equal(a, b);
  assert.ok(a.includes("<path>") && a.includes("<n>"));
});

test("同类失败 3 次成一条短板", () => {
  const rows = [1, 2, 3].map(() => ev("red", { meta: { blockers: [{ message: "文件没被验证覆盖" }] } }));
  const r = clusterFailures(rows, { now, minCount: 3 });
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].count, 3);
  assert.equal(r.clusters[0].taskType, "coding");
});

test("不足阈值不输出", () => {
  const rows = [ev("red", { meta: { blockers: [{ message: "X" }] } }), ev("red", { meta: { blockers: [{ message: "X" }] } })];
  assert.equal(clusterFailures(rows, { now, minCount: 3 }).clusters.length, 0);
});

test("不同错误签名不合并", () => {
  const rows = [
    ev("red", { meta: { blockers: [{ message: "A 问题" }] } }),
    ev("red", { meta: { blockers: [{ message: "A 问题" }] } }),
    ev("red", { meta: { blockers: [{ message: "A 问题" }] } }),
    ev("red", { meta: { blockers: [{ message: "B 问题" }] } }),
    ev("red", { meta: { blockers: [{ message: "B 问题" }] } }),
    ev("red", { meta: { blockers: [{ message: "B 问题" }] } }),
  ];
  const r = clusterFailures(rows, { now, minCount: 3 });
  assert.equal(r.clusters.length, 2);
});

test("成功事件不入聚类；窗口外的不算", () => {
  const old = ev("red", { at: new Date(now - 30 * 24 * 3600_000).toISOString(), meta: { blockers: [{ message: "old" }] } });
  const rows = [ev("green"), ev("keep"), old];
  const r = clusterFailures(rows, { now, minCount: 1 });
  assert.equal(r.failed, 0);
  assert.equal(r.clusters.length, 0);
});

test("转提案：字段齐全且带封存版本", () => {
  const cluster = { target: "delivery", targetId: "run1", taskType: "coding", signature: "文件没被验证覆盖", count: 4, suggestion: "x" };
  const p = toProposalInput(cluster);
  assert.equal(p.targetId, "run1");
  assert.equal(p.n, 4);
  assert.equal(p.datasetVersion, "sealed-v1");
  assert.ok(p.hypothesis.length > 0);
});
