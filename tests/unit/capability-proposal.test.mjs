// 知识长能力：提案必须带证据/测试/收益，且 shipped 不能空喊（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mineSignals, refreshProposals, markProposal, proposalsLine, areaOf } from "../../engine/capability-proposal.mjs";

function wsWith({ feedback = [], jobs = {}, oplog = "" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
  fs.mkdirSync(path.join(root, "feedback"), { recursive: true });
  fs.writeFileSync(path.join(root, "feedback", "inbox.json"), JSON.stringify({ items: feedback }), "utf8");
  fs.mkdirSync(path.join(root, "记忆", "知识"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆", "知识", "state.json"), JSON.stringify({ jobs }), "utf8");
  if (oplog) {
    const lp = path.join(root, "..", `oplog-${path.basename(root)}.md`);
    fs.writeFileSync(lp, oplog, "utf8");
    fs.mkdirSync(path.join(root, "deepseek"), { recursive: true });
    fs.writeFileSync(path.join(root, "deepseek", "元枢-操作日志.md"), oplog, "utf8");
  }
  return root;
}

test("崩溃反馈能变成能力提案，并带证据/测试/收益", () => {
  const ws = wsWith({ feedback: [{ id: "f1", at: Date.now(), kind: "crash", title: "[自动上报] crash: [exit] code=1 ffmpeg 响度测量失败", detail: "stderr 没读到" }] });
  const { proposals } = mineSignals({ wsRoot: ws });
  assert.ok(proposals.length >= 1);
  const p = proposals[0];
  assert.equal(p.area, "audio");
  assert.ok(p.evidence.length >= 1);
  assert.match(p.test, /output_check|LUFS/);
  assert.ok(p.effect.length > 4);
  assert.equal(p.state, "proposed");
});

test("同一类问题重复出现 → 分数更高（这不是「感觉重要」，是可数的）", () => {
  const ws1 = wsWith({ feedback: [{ id: "a", at: Date.now(), kind: "crash", title: "crash: powershell 乱码" }] });
  const ws2 = wsWith({ feedback: [
    { id: "a", at: Date.now(), kind: "crash", title: "crash: powershell 乱码" },
    { id: "b", at: Date.now(), kind: "crash", title: "crash: powershell 乱码" },
    { id: "c", at: Date.now(), kind: "crash", title: "crash: powershell 乱码" },
  ] });
  const one = mineSignals({ wsRoot: ws1 }).proposals[0];
  const many = mineSignals({ wsRoot: ws2 }).proposals[0];
  assert.ok(many.score > one.score, `${many.score} 应大于 ${one.score}`);
  assert.equal(many.recurrence, 3);
});

test("agent 卡在某个 reason 上也算信号", () => {
  const ws = wsWith({ jobs: { a: { state: "blocked", reason: "source_not_authorized" }, b: { state: "blocked", reason: "source_not_authorized" } } });
  const { proposals } = mineSignals({ wsRoot: ws });
  assert.ok(proposals.some((p) => /source_not_authorized/.test(p.symptom)));
});

test("shipped 必须带 version/commit/test，否则拒绝（不许空喊做完了）", () => {
  const ws = wsWith({ feedback: [{ id: "a", at: Date.now(), kind: "crash", title: "crash: 部署反复重启" }] });
  refreshProposals(ws, {});
  const id = JSON.parse(fs.readFileSync(path.join(ws, "记忆", "运行时", "能力提案.json"), "utf8")).items[0].id;
  assert.equal(markProposal(ws, id, { state: "accepted" }).ok, true);
  const bad = markProposal(ws, id, { state: "shipped", version: "2.130.0" });
  assert.match(bad.error, /test|commit/);
  const ok = markProposal(ws, id, { state: "shipped", version: "2.130.0", commit: "abc1234", test: "tests/unit/deploy.test.mjs" });
  assert.equal(ok.ok, true);
  assert.equal(ok.item.state, "shipped");
});

test("刷新不会把已 accept/shipped 的状态冲掉", () => {
  const ws = wsWith({ feedback: [{ id: "a", at: Date.now(), kind: "crash", title: "crash: 知识 journal 校验失败" }] });
  refreshProposals(ws, {});
  const before = JSON.parse(fs.readFileSync(path.join(ws, "记忆", "运行时", "能力提案.json"), "utf8")).items[0];
  markProposal(ws, before.id, { state: "accepted", note: "下版做" });
  refreshProposals(ws, {});
  const after = JSON.parse(fs.readFileSync(path.join(ws, "记忆", "运行时", "能力提案.json"), "utf8")).items.find((p) => p.id === before.id);
  assert.equal(after.state, "accepted");
  assert.equal(after.note, "下版做");
});

test("areaOf 认得出来领域；提案行只报待评估的", () => {
  assert.equal(areaOf("ffmpeg 响度").area, "audio");
  assert.equal(areaOf("powershell 乱码").area, "shell");
  const ws = wsWith({ feedback: [{ id: "a", at: Date.now(), kind: "crash", title: "crash: mcp 超时" }] });
  refreshProposals(ws, {});
  assert.match(proposalsLine(ws), /长能力/);
});
