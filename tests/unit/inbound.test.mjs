// 入站事件：归一/匹配/落账（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recvEvent, listEvents, matchWatches, inboundLine } from "../../engine/inbound.mjs";
import { addWatch } from "../../engine/proactive-manager.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "inbound-"));

test("收事件：落账 + 返回匹配结果", () => {
  const root = ws();
  addWatch({ wsRoot: root, title: "资料库权限", keywords: ["权限"] });
  const r = recvEvent({ wsRoot: root, source: "dingtalk", kind: "mention", text: "老师通知：明天交回执，权限表要更新" });
  assert.equal(r.ok, true);
  assert.equal(r.matched.length, 1);
  assert.match(r.event.id, /^in-/);
  const items = listEvents(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "dingtalk");
});

test("关键词匹配：中文包含即算，短词不算", () => {
  const watches = [
    { id: "w1", title: "机票价格", keywords: ["机票", "价格"], status: "watching" },
    { id: "w2", title: "x", keywords: ["a"], status: "watching" },
    { id: "w3", title: "已停", keywords: ["机票"], status: "paused" },
  ];
  const m = matchWatches("明天机票价格降了两百", watches);
  assert.equal(m.length, 1);
  assert.equal(m[0].id, "w1", "停掉的不该命中；单字符关键词不算");
});

test("空 source / 空 text 被拒", () => {
  const root = ws();
  assert.equal(recvEvent({ wsRoot: root, source: "", text: "x" }).ok, false);
  assert.equal(recvEvent({ wsRoot: root, source: "mail", text: "" }).ok, false);
  assert.equal(listEvents(root).length, 0);
});

test("高优先事件即使没命中也会进汇报台账", () => {
  const root = ws();
  const r = recvEvent({ wsRoot: root, source: "monitor", kind: "alert", text: "磁盘只剩 3GB", severity: "high" });
  assert.equal(r.reported, true, "high 应该被报上去");
  const ledger = JSON.parse(fs.readFileSync(path.join(root, "记忆", "运行时", "待汇报.json"), "utf8"));
  const rows = Array.isArray(ledger) ? ledger : ledger.items || [];
  assert.ok(rows.some((x) => x.kind === "inbound"));
});

test("普通事件不命中就不打扰", () => {
  const root = ws();
  const r = recvEvent({ wsRoot: root, source: "news", text: "今天天气不错", severity: "low" });
  assert.equal(r.reported, false);
  assert.equal(inboundLine(root), "");
});

test("环境事实一行：命中时才出现，2 小时外不算", () => {
  const root = ws();
  addWatch({ wsRoot: root, title: "机票", keywords: ["机票"] });
  recvEvent({ wsRoot: root, source: "mail", text: "机票又降了 200", at: Date.now() });
  assert.match(inboundLine(root), /【外部事件】/);

  const old = Date.now() - 3 * 3600 * 1000;
  const root2 = ws();
  addWatch({ wsRoot: root2, title: "机票", keywords: ["机票"] });
  recvEvent({ wsRoot: root2, source: "mail", text: "机票又降了", at: old });
  assert.equal(inboundLine(root2), "");
});
