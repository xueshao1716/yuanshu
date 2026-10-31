// 行动权清单同步 + 长任务完成推送的测试（2026-10-31）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncActionRights, removeActionRights, readRights, buildBlock, MARK_BEGIN, MARK_END } from "../../engine/action-rights.mjs";
import { createNotifier } from "../../engine/notifier.mjs";

const ws = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rights-"));
  fs.mkdirSync(path.join(root, "记忆"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆", "行动权清单.md"), "# 清单\n\n- 我直接做：读文件\n- 等点头：对外发布\n", "utf8");
  return root;
};
const agentDir = (root) => path.join(root, "agent");

test("清单会写进 APPEND_SYSTEM，并带标记块", () => {
  const root = ws();
  const r = syncActionRights({ wsRoot: root, agentDir: agentDir(root) });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  const out = fs.readFileSync(path.join(agentDir(root), "APPEND_SYSTEM.md"), "utf8");
  assert.ok(out.includes(MARK_BEGIN));
  assert.ok(out.includes(MARK_END));
  assert.match(out, /等点头：对外发布/);
});

test("再同步一次不重复追加（changed=false）", () => {
  const root = ws();
  syncActionRights({ wsRoot: root, agentDir: agentDir(root) });
  const again = syncActionRights({ wsRoot: root, agentDir: agentDir(root) });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  const out = fs.readFileSync(path.join(agentDir(root), "APPEND_SYSTEM.md"), "utf8");
  assert.equal((out.match(new RegExp(MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
});

test("清单改了会替换旧块，不破坏人格块", () => {
  const root = ws();
  const target = path.join(agentDir(root), "APPEND_SYSTEM.md");
  fs.mkdirSync(agentDir(root), { recursive: true });
  fs.writeFileSync(target, "<!-- persona:begin -->\n旧人格\n<!-- persona:end -->\n", "utf8");
  syncActionRights({ wsRoot: root, agentDir: agentDir(root) });
  fs.writeFileSync(path.join(root, "记忆", "行动权清单.md"), "# 清单\n\n- 新规则：不许删数据\n", "utf8");
  const r = syncActionRights({ wsRoot: root, agentDir: agentDir(root) });
  assert.equal(r.changed, true);
  const out = fs.readFileSync(target, "utf8");
  assert.match(out, /不许删数据/);
  assert.ok(!out.includes("等点头：对外发布"), "旧内容应被替换");
  assert.match(out, /旧人格/, "人格块必须保留");
});

test("清单不存在时给明确失败，不写空块", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rights2-"));
  const r = syncActionRights({ wsRoot: root, agentDir: agentDir(root) });
  assert.equal(r.ok, false);
  assert.match(r.error, /读不到/);
});

test("removeActionRights 只摘清单块", () => {
  const root = ws();
  const target = path.join(agentDir(root), "APPEND_SYSTEM.md");
  fs.mkdirSync(agentDir(root), { recursive: true });
  fs.writeFileSync(target, "<!-- persona:begin -->\n人格\n<!-- persona:end -->\n", "utf8");
  syncActionRights({ wsRoot: root, agentDir: agentDir(root) });
  removeActionRights({ agentDir: agentDir(root) });
  const out = fs.readFileSync(target, "utf8");
  assert.ok(!out.includes(MARK_BEGIN));
  assert.match(out, /人格/);
});

test("buildBlock 空文本不给块", () => {
  assert.equal(buildBlock(""), "");
  assert.match(buildBlock("x"), /行动权清单/);
});

test("notifier.runFinished：长任务完成会推到微信，带她写的正文", async () => {
  const sent = [];
  const n = createNotifier({ file: null, wechat: { notifyOwner: async (t) => { sent.push(t) } }, now: () => Date.parse("2026-10-31T21:00:00") });
  const run = { id: "r1", sessionId: "s1", status: "completed", startedAt: "2026-10-31T20:55:00", completedAt: "2026-10-31T20:59:12" };
  const r = await n.runFinished(run, {
    toWechat: true,
    compose: async () => ({ title: "晚上 20:59", body: "调研报告写完了，11 页", sender: "小语", summary: "长任务完成", facts: ["用时 4 分 12 秒"] }),
  });
  assert.equal(r.wechat, "sent");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /小语/);
  assert.match(sent[0], /调研报告写完了/);
  assert.match(sent[0], /4 分 12 秒/);
});

test("notifier.runFinished：短任务不打扰", async () => {
  const sent = [];
  const n = createNotifier({ file: null, wechat: { notifyOwner: async (t) => { sent.push(t) } } });
  const run = { id: "r2", sessionId: "s2", status: "completed", startedAt: "2026-10-31T20:55:00", completedAt: "2026-10-31T20:55:02" };
  const r = await n.runFinished(run, { toWechat: true });
  assert.equal(r, null);
  assert.equal(sent.length, 0);
});
