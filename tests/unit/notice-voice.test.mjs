// 主动推送话术：人设名 / 说清什么事 / 排版校验（2026-10-30）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeNotice, checkNotice, personaName, noticeEnvelope, FALLBACK } from "../../engine/notice-voice.mjs";
import { formatWechatPush } from "../../engine/wechat-push-format.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "voice-"));

test("人设名从人格定义读；读不到回退小语", () => {
  const root = ws();
  assert.equal(personaName(root), "小语");
  fs.mkdirSync(path.join(root, "记忆"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆", "人格定义.json"), JSON.stringify({ name: "阿语" }), "utf8");
  assert.equal(personaName(root), "阿语");
});

test("校验：禁用「元枢」「详情在元枢」", () => {
  assert.equal(checkNotice("元枢 · 下午，回来看看").ok, false);
  assert.equal(checkNotice("有 3 件事等你，回来看看").ok, true);
  assert.equal(checkNotice("详情在元枢").ok, false);
});

test("校验：太长 / 空 / 看不出发生了什么都算不合格", () => {
  assert.equal(checkNotice("").ok, false);
  assert.equal(checkNotice("嗯".repeat(120)).ok, false);
  const r = checkNotice("在吗");
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /没看出发生了什么/);
});

test("她自己写的合格话术会被采用", async () => {
  const out = await composeNotice({
    kind: "away", facts: { away: "49 分钟" }, wsRoot: ws(),
    write: async () => "你走了 49 分钟，那版海报还留着，回来我接着改？",
  });
  assert.equal(out.source, "model");
  assert.match(out.text, /49 分钟/);
});

test("第一次写了禁用词 → 重写一次", async () => {
  let n = 0;
  const out = await composeNotice({
    kind: "away", facts: { away: "1 小时" }, wsRoot: ws(),
    write: async () => {
      n += 1;
      return n === 1 ? "元枢 · 下午，离开 1 小时了" : "你走了一小时，手上的活还在，回来吗？";
    },
  });
  assert.equal(n, 2);
  assert.equal(out.source, "model-retry");
  assert.ok(!out.text.includes("元枢"));
});

test("两次都不合格 → 用兜底话术（绝不发空白）", async () => {
  const out = await composeNotice({ kind: "away", facts: { away: "2 小时" }, wsRoot: ws(), write: async () => "元枢 详情在元枢" });
  assert.equal(out.source, "fallback");
  assert.match(out.text, /2 小时/);
  assert.ok(!out.text.includes("元枢"));
});

test("没有写作通道也能给兜底", async () => {
  const out = await composeNotice({ kind: "night", facts: { learned: 3 } });
  assert.equal(out.source, "fallback");
  assert.match(out.text, /3 条/);
});

test("信封：抬眼是时间、摘要说清什么事", () => {
  const env = noticeEnvelope({ kind: "morning", facts: { pending: 4, first: "改海报" }, now: new Date("2026-10-30T08:10:00").getTime(), text: "早" });
  assert.match(env.head, /早上 08:10/);
  assert.match(env.summary, /4 件待办/);
  assert.match(env.summary, /改海报/);
});

test("微信排版：抬头带人设名，结尾是「什么事」不是「详情在元枢」", () => {
  const text = formatWechatPush({
    title: "下午 16:42", body: "你走了 49 分钟，海报还留着", kind: "companion",
    sender: "小语", summary: "你离开 49 分钟，活还留着", now: new Date("2026-10-30T16:42:00"),
  });
  assert.match(text, /小语/);
  assert.match(text, /16:42 · 你离开 49 分钟/);
  assert.ok(!text.includes("详情在元枢"));
  assert.ok(!text.includes("元枢 ·"));
});

test('反思类：没有数据时不许说「发现了什么问题」（编造守卫）', () => {
  const bad = checkNotice('刚复盘发现一处关键遗漏，已沉淀修正方案', { kind: 'reflection', facts: {} });
  assert.equal(bad.ok, false);
  assert.match(bad.reasons.join(' '), /没有轨迹却说有发现/);
  const ok = checkNotice('回放了 42 条轨迹，沉淀 2 条', { kind: 'reflection', facts: { events: 42, learned: 2 } });
  assert.equal(ok.ok, true);
});

test('反思类的兜底话术说清回放了多少条', async () => {
  const out = await composeNotice({ kind: 'reflection', facts: { events: 42, winner: 'v3' }, wsRoot: ws() });
  assert.equal(out.source, 'fallback');
  assert.match(out.text, /42/);
});

test('交付门 RED：done 类不许说完成，直接给没过门的兜底', async () => {
  const gate = { verdict: 'RED', summary: '1 个改动文件没被验证覆盖' };
  const out = await composeNotice({ kind: 'done', facts: { what: '海报', minutes: 3, gate }, wsRoot: ws() });
  assert.equal(out.source, 'fallback');
  assert.match(out.text, /交付门没过/);
  assert.match(out.text, /没被验证覆盖/);
  assert.ok(!/做完了.*看一眼/.test(out.text), 'RED 时不能是那句轻松的完成话术');
});

test('交付门 GREEN：正常说完成', async () => {
  const out = await composeNotice({ kind: 'done', facts: { what: '海报', minutes: 3, gate: { verdict: 'GREEN' } }, wsRoot: ws() });
  assert.match(out.text, /做完了/);
  assert.ok(!/交付门/.test(out.text));
});

test('离开推送：报完成/卡住/待拍板的具体事实', () => {
  const t = FALLBACK.away({ away: '6 小时', done: ['晨报', '资产整理'], blocked: ['一次交付RED'], asks: 2 });
  assert.match(t, /做完 2 件/);
  assert.match(t, /晨报/);
  assert.match(t, /1 件卡住/);
  assert.match(t, /2 件事等你拍板/);
  assert.ok(!/回来接着做/.test(t), '不许再问回来接着做');
});

test('离开推送：没有事实就明说，不编数字', () => {
  const t = FALLBACK.away({ away: '2 小时' });
  assert.match(t, /没新动静/);
  assert.ok(!/做完/.test(t));
  assert.ok(!/等你拍板/.test(t));
});
