// 路由器：快筛、判断解析、决策落盘（2026-11-01）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fastFilter, parseDecision, recordDecision, recentDecisions, routeEvent, buildRoutePrompt, routerFile } from "../../engine/router.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "router-"));

test("快筛：噪音/空/超长/白名单/重复", () => {
  assert.equal(fastFilter({ text: "收到" }).pass, false);
  assert.equal(fastFilter({ text: "" }).pass, false);
  assert.equal(fastFilter({ text: "x".repeat(5000) }).pass, false);
  assert.equal(fastFilter({ text: "帮我查下这个报错", source: "mail" }, { sources: ["wechat"] }).pass, false);
  const seen = new Set(["mail|帮我查下这个报错"]);
  assert.equal(fastFilter({ text: "帮我查下这个报错", source: "mail" }, { seen }).pass, false);
  assert.equal(fastFilter({ text: "帮我查下这个报错", source: "mail" }, { sources: ["mail"] }).pass, true);
});

test("解析：合法 dispatch 通过", () => {
  const r = parseDecision('{"action":"dispatch","reason":"是修 bug","task":"修 auth.test.mjs"}');
  assert.equal(r.ok, true);
  assert.equal(r.action, "dispatch");
  assert.equal(r.task, "修 auth.test.mjs");
});

test("解析：dispatch 没有 task 视为无效", () => {
  assert.equal(parseDecision('{"action":"dispatch","reason":"x"}').ok, false);
});

test("解析：能从解说文字里抠出 JSON", () => {
  const r = parseDecision('我判断如下：\n{"action":"ignore","reason":"广告"}\n以上。');
  assert.equal(r.ok, true);
  assert.equal(r.action, "ignore");
});

test("解析：动作不合法就拒绝", () => {
  assert.equal(parseDecision('{"action":"run","reason":"x"}').ok, false);
  assert.equal(parseDecision("啥也没有").ok, false);
});

test("决策落盘 + 读回", () => {
  const root = ws();
  recordDecision(root, { source: "mail", action: "dispatch", reason: "修 bug", task: "跑测试" });
  recordDecision(root, { source: "wechat", action: "ignore", reason: "闲聊" });
  const rows = recentDecisions(root, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, "ignore");   // 最新的在前
  assert.equal(rows[1].task, "跑测试");
  assert.ok(fs.existsSync(routerFile(root)));
});

test("routeEvent：快筛拦下的不调用模型", async () => {
  const root = ws();
  let called = 0;
  const r = await routeEvent({ event: { text: "收到", source: "wechat" }, wsRoot: root, think: async () => { called += 1; return "{}" } });
  assert.equal(r.action, "ignore");
  assert.equal(r.by, "fast");
  assert.equal(called, 0, "噪音不该花钱");
});

test("routeEvent：慢判 dispatch 会把 task 记下来", async () => {
  const root = ws();
  const r = await routeEvent({
    event: { text: "CI 挂了，auth.test 失败", source: "mail" }, wsRoot: root,
    think: async () => '{"action":"dispatch","reason":"需要修","task":"跑 auth.test 并修"}',
  });
  assert.equal(r.action, "dispatch");
  assert.equal(r.task, "跑 auth.test 并修");
  assert.equal(recentDecisions(root, 5)[0].action, "dispatch");
});

test("routeEvent：模型胡说不算数，记为 ignore 并说明", async () => {
  const root = ws();
  const r = await routeEvent({ event: { text: "随便一件事", source: "mail" }, wsRoot: root, think: async () => "我不知道" });
  assert.equal(r.ok, false);
  assert.match(recentDecisions(root, 5)[0].reason, /判断失败/);
});

test("提示词包含三档动作与 JSON 要求", () => {
  const p = buildRoutePrompt({ text: "帮我看看", source: "mail" });
  assert.match(p, /ignore/);
  assert.match(p, /ask/);
  assert.match(p, /dispatch/);
  assert.match(p, /只输出一个 JSON/);
});
