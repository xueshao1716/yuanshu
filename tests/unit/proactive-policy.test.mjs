// 三档主动触达：死夜 / priority / per-topic 冷却 / urgency 配额 / 连续无回复 / 与旧预算取更严 / 文案变体
// （2026-11-09，来源：曦 proactive_outreach.py + concern_scanner.py + 心屿 HEARTBEAT.md）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TRIGGERS, DEAD_NIGHT, NO_REPLY_LIMIT, HOUR,
  decide, quotaFor, pickText, isDeadNight, dayKey, consecutiveNoReply,
} from "../../engine/proactive-policy.mjs";
import {
  recordOutreach, readOutreach, markOutreachReplied, outreachStats, outreachStreak, OUTREACH_REL,
} from "../../engine/proactive-journal.mjs";

// 2026-11-09 是周一；都用本地时间构造，测试在任何时区都一样
const at = (hour, minute = 0, day = 9) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();
const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
const row = (trigger, ms, extra = {}) => ({
  at: ms, trigger, urgency: TRIGGERS[trigger]?.urgency || "low",
  topic: extra.topic || trigger, textId: "", replied: false, ...extra,
});

test("触发表：6 类齐全，priority / cooldown 就是曦那张表，每类 3-4 句变体", () => {
  const table = Object.fromEntries(Object.entries(TRIGGERS).map(([k, v]) => [k, { p: v.priority, h: v.cooldownMs / HOUR }]));
  assert.deepEqual(table, {
    mood_dip: { p: 85, h: 4 },
    late_night: { p: 80, h: 6 },
    concern_scan: { p: 75, h: 3 },
    long_silence: { p: 70, h: 4 },
    positive_vibe: { p: 60, h: 3 },
    open_loop: { p: 72, h: 6 },
  });
  for (const [k, v] of Object.entries(TRIGGERS)) {
    assert.ok(v.variants.length >= 3 && v.variants.length <= 4, `${k} 应该有 3-4 句变体，实际 ${v.variants.length}`);
    assert.ok(["high", "medium", "low"].includes(v.urgency), `${k} 的 urgency 必须是三档之一`);
  }
  assert.equal(DEAD_NIGHT.from, 1);
  assert.equal(DEAD_NIGHT.to, 7);
});

test("死夜：本地 1-7 点任何 trigger 一律 hold（high priority 也不放行）", () => {
  for (const [h, m] of [[1, 0], [3, 0], [6, 59]]) {
    for (const trigger of ["mood_dip", "concern_scan", "late_night", "long_silence", "positive_vibe", "open_loop"]) {
      const d = decide({ now: at(h, m), candidates: [{ trigger }] });
      assert.equal(d.action, "hold", `${trigger} 在 ${h}:${m} 应该 hold`);
      assert.equal(d.reason, "dead_night");
      assert.equal(d.deadNight, true);
    }
  }
  // 边界：0 点与 7 点都不算死夜（死夜是 [1,7)）
  assert.equal(isDeadNight(at(0, 30)), false);
  assert.equal(isDeadNight(at(7, 0)), false);
  assert.equal(decide({ now: at(0, 30), candidates: [{ trigger: "mood_dip" }] }).action, "send");
  assert.equal(decide({ now: at(7, 0), candidates: [{ trigger: "mood_dip" }] }).action, "send");
});

test("priority：两个候选只发优先级高的那条，低的 hold（不是也发一条）", () => {
  const d = decide({
    now: at(15),
    candidates: [{ trigger: "long_silence", vars: { away: "5 小时" } }, { trigger: "mood_dip" }],
  });
  assert.equal(d.action, "send");
  assert.equal(d.trigger, "mood_dip", "85 > 70，先发 mood_dip");
  assert.equal(d.priority, 85);
  assert.equal(d.rank[0].trigger, "mood_dip");
  const lower = d.held.find((h) => h.trigger === "long_silence");
  assert.ok(lower, "低优先级候选要出现在 held 里");
  assert.equal(lower.reason, "lower_priority");
  assert.equal(d.held.length, 1, "一轮只发一条，不能两条都发");
});

test("priority：高优先级被冷却挡住时，低优先级可以上位", () => {
  const t0 = at(15);
  const d = decide({
    now: t0 + 60 * 60 * 1000, // mood_dip 冷却 4h 内
    candidates: [{ trigger: "mood_dip" }, { trigger: "long_silence", vars: { away: "6 小时" } }],
    state: { recent: [row("mood_dip", t0)] },
  });
  assert.equal(d.action, "send");
  assert.equal(d.trigger, "long_silence");
  assert.ok(d.held.some((h) => h.trigger === "mood_dip" && h.reason === "topic_cooldown"));
});

test("per-topic 冷却：同 topic 冷却内不再发，不同 topic 不受影响", () => {
  const t0 = at(15);
  const state = { recent: [row("mood_dip", t0, { topic: "mood" })] };
  const same = decide({ now: t0 + HOUR, candidates: [{ trigger: "mood_dip", topic: "mood" }], state });
  assert.equal(same.action, "hold");
  assert.equal(same.reason, "topic_cooldown");

  const other = decide({ now: t0 + HOUR, candidates: [{ trigger: "concern_scan", topic: "concern:部署" }], state });
  assert.equal(other.action, "send", "别的 topic 不该被牵连");

  const later = decide({ now: t0 + TRIGGERS.mood_dip.cooldownMs + 1, candidates: [{ trigger: "mood_dip", topic: "mood" }], state });
  assert.equal(later.action, "send", "过了冷却可以再发");
});

test("urgency 配额：medium 一天最多 1 条，第二天恢复；low 只在当天没别的可说时兜底", () => {
  const t1 = at(23, 30); // late_night 的窗口（23-24），且不在死夜
  const first = decide({ now: t1, candidates: [{ trigger: "late_night", vars: { hour: 23 } }] });
  assert.equal(first.action, "send");
  assert.equal(first.urgency, "medium");

  const state = { recent: [row("late_night", t1)] };
  const second = decide({ now: t1 + 10 * 60 * 1000, candidates: [{ trigger: "long_silence", vars: { away: "8 小时" } }], state });
  assert.equal(second.action, "drop", "medium 配额用完，今天不再发");
  assert.equal(second.reason, "quota_medium");

  const nextDay = decide({ now: at(23, 30, 10), candidates: [{ trigger: "long_silence", vars: { away: "8 小时" } }], state });
  assert.equal(nextDay.action, "send", "换一天配额重置");

  // low 兜底：今天一句都没说过 → 发；已经说过 → 今天不再补
  assert.equal(decide({ now: at(15), candidates: [{ trigger: "positive_vibe" }] }).action, "send");
  const lowAfter = decide({
    now: at(15, 30), candidates: [{ trigger: "positive_vibe" }],
    state: { recent: [row("mood_dip", at(15, 10))] },
  });
  assert.equal(lowAfter.action, "drop");
  assert.equal(lowAfter.reason, "quota_low_fallback");
});

test("连续 3 条没回复 → 暂停（第 4 条 hold），有一条回复就恢复", () => {
  const t0 = at(15);
  const three = [row("mood_dip", t0 - 3 * HOUR), row("late_night", t0 - 2 * HOUR), row("long_silence", t0 - HOUR)];
  const cand = [{ trigger: "concern_scan", topic: "concern:新信号" }];

  const two = decide({ now: t0, candidates: cand, state: { recent: three.slice(0, 2) } });
  assert.equal(two.action, "send", "才两条没回复，还能发");
  assert.equal(two.streak, 2);

  const paused = decide({ now: t0, candidates: cand, state: { recent: three } });
  assert.equal(paused.action, "hold");
  assert.equal(paused.reason, "no_reply_pause");
  assert.equal(paused.streak, NO_REPLY_LIMIT);

  const resumed = decide({
    now: t0 + 60 * 1000, candidates: cand,
    state: { recent: [three[0], three[1], { ...three[2], replied: true }] },
  });
  assert.equal(resumed.action, "send", "最后一条被回过，暂停解除");
  assert.equal(resumed.streak, 0);
  assert.equal(consecutiveNoReply([{ replied: true }, { replied: false }, { replied: false }]), 2);
});

test("与旧预算/旧免打扰冲突时取更严：预算 0 直接 drop，静默/dnd 一律 hold", () => {
  const cand = [{ trigger: "mood_dip" }];
  const noBudget = decide({ now: at(15), candidates: cand, state: { budgetRemaining: 0 } });
  assert.equal(noBudget.action, "drop");
  assert.equal(noBudget.reason, "legacy_budget");

  const hasBudget = decide({ now: at(15), candidates: cand, state: { budgetRemaining: 2 } });
  assert.equal(hasBudget.action, "send", "旧预算还有额度就不用比它更严");

  const quiet = decide({ now: at(15), candidates: cand, state: { quietHours: true } });
  assert.equal(quiet.action, "hold");
  assert.equal(quiet.reason, "legacy_quiet");

  const dnd = decide({ now: at(15), candidates: cand, state: { dnd: true } });
  assert.equal(dnd.reason, "legacy_dnd");

  const gap = decide({ now: at(15, 30), candidates: cand, state: { minGapMs: 2 * HOUR, lastSentAt: at(14, 30) } });
  assert.equal(gap.reason, "legacy_min_gap");

  // 死夜比旧预算更靠前（半夜预算为 0 也报 dead_night，不报预算）
  const night = decide({ now: at(3), candidates: cand, state: { budgetRemaining: 0 } });
  assert.equal(night.reason, "dead_night");
});

test("quotaFor：high 全发 / medium 1 / low 兜底 1", () => {
  assert.equal(quotaFor("high").limit, Number.POSITIVE_INFINITY);
  assert.equal(quotaFor("high").unlimited, true);
  assert.equal(quotaFor("medium").limit, 1);
  assert.equal(quotaFor("medium").fallbackOnly, false);
  assert.equal(quotaFor("low").limit, 1);
  assert.equal(quotaFor("low").fallbackOnly, true);
  assert.equal(quotaFor().urgency, "low", "未知档位按最保守的 low 处理");
});

test("文案变体：同 trigger 换着说，不给大括号，注入随机源可复现", () => {
  const seen = new Set();
  for (let i = 0; i < 4; i += 1) seen.add(pickText("mood_dip", { rand: () => i / 4 }).id);
  assert.equal(seen.size, 4, "4 句变体应该都能取到");

  // 同一个 rand 也不连着说同一句（avoidId 兜住）
  const a = pickText("mood_dip", { rand: () => 0 });
  const b = pickText("mood_dip", { rand: () => 0, avoidId: a.id });
  assert.notEqual(a.id, b.id);

  // 占位符要替换掉；没给变量也不许把 {topic} 漏给用户
  const late = pickText("late_night", { rand: () => 0.1, vars: { hour: 23 } });
  assert.match(late.text, /23/);
  const bare = pickText("concern_scan", { rand: () => 0.1 });
  assert.doesNotMatch(bare.text, /[{}]/);
  assert.doesNotMatch(late.text, /[{}]/);
  assert.match(late.id, /^late_night#\d$/);
});

test("decide 出来的文案也不会连着重复同一句（台账里的 textId 当 avoidId）", () => {
  const t0 = at(15);
  const r1 = decide({ now: t0, candidates: [{ trigger: "mood_dip" }], state: { rand: () => 0 } });
  assert.equal(r1.action, "send");
  assert.match(r1.textId, /^mood_dip#\d$/);
  const r2 = decide({
    now: t0 + TRIGGERS.mood_dip.cooldownMs + 1000,
    candidates: [{ trigger: "mood_dip" }],
    state: { recent: [row("mood_dip", t0, { textId: r1.textId })], rand: () => 0 },
  });
  assert.equal(r2.action, "send");
  assert.notEqual(r2.textId, r1.textId, "同样的随机数也要换一句");
});

test("台账：写一行读一行，标记回复后连续计数归零", () => {
  const root = ws();
  assert.deepEqual(readOutreach(root), []);
  const one = recordOutreach(root, {
    at: at(15), trigger: "mood_dip", priority: 85, urgency: "high",
    topic: "mood_dip", text: "看你这两天不太对劲", textId: "mood_dip#0",
  });
  assert.equal(one.ok, true);
  recordOutreach(root, { at: at(16), trigger: "long_silence", priority: 70, urgency: "medium", topic: "companion:nudge" });
  const rows = readOutreach(root);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].trigger, "mood_dip", "读出来是按时间正序");
  assert.equal(rows[0].replied, false);
  assert.ok(fs.existsSync(path.join(root, OUTREACH_REL)), "落盘在 记忆/运行时/主动推送.jsonl");
  assert.equal(outreachStreak(root), 2);

  assert.equal(markOutreachReplied(root, { now: at(17) }).marked, 2);
  assert.equal(outreachStreak(root), 0);
  assert.deepEqual(outreachStats(root, { days: 30, now: at(18) }).map((x) => [x.trigger, x.sent, x.replied]), [
    ["mood_dip", 1, 1], ["long_silence", 1, 1],
  ]);
});

test("台账接上 decide：三条没回复就是从台账里读出来的", () => {
  const root = ws();
  for (const [i, trigger] of ["mood_dip", "late_night", "long_silence"].entries()) {
    recordOutreach(root, { at: at(12 + i), trigger, topic: trigger });
  }
  const d = decide({ now: at(15), candidates: [{ trigger: "concern_scan", topic: "concern:新" }], state: { recent: readOutreach(root) } });
  assert.equal(d.action, "hold");
  assert.equal(d.reason, "no_reply_pause");
  assert.equal(d.streak, 3);

  markOutreachReplied(root, { now: at(15, 30) });
  const after = decide({ now: at(15, 30), candidates: [{ trigger: "concern_scan", topic: "concern:新" }], state: { recent: readOutreach(root) } });
  assert.equal(after.action, "send");
});

test("接线：久不互动推送先过策略层（死夜不推、连续没回复不推、推了落台账）", async () => {
  const { runCompanionNudge, NUDGE_IDLE_MS } = await import("../../engine/companion-nudge.mjs");
  const root = ws();
  let sent = 0;
  const env = (now, extra = {}) => ({
    store: {
      seen: () => ({ seenAt: now - NUDGE_IDLE_MS - 1, nudgeAt: 0 }),
      preferences: () => ({ dnd: false }),
      markNudge: () => {},
    },
    notifier: { notify: async () => { sent += 1; return { ok: true, event: { id: "n1" } } } },
    now: () => now, wsRoot: root, ...extra,
  });

  const night = await runCompanionNudge(env(at(3)));
  assert.equal(night.ok, false);
  assert.equal(night.reason, "dead_night", "凌晨三点不许推");
  assert.equal(sent, 0);
  assert.equal(readOutreach(root).length, 0, "没推就不该记台账");

  const day = await runCompanionNudge(env(at(15)));
  assert.equal(day.ok, true);
  assert.equal(sent, 1);
  assert.equal(day.trigger, "long_silence");
  assert.ok(day.text, "要有兜底文案，不能是空字符串");
  const rows = readOutreach(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trigger, "long_silence");
  assert.equal(rows[0].topic, "companion:nudge");
  assert.ok(rows[0].textId, "要记下用了哪一句");

  // 再塞两条没回复的 → 第三条之后必须暂停
  recordOutreach(root, { at: at(16), trigger: "mood_dip", topic: "mood_dip" });
  recordOutreach(root, { at: at(17), trigger: "late_night", topic: "late_night" });
  const paused = await runCompanionNudge(env(at(18)));
  assert.equal(paused.ok, false);
  assert.equal(paused.reason, "no_reply_pause");
  assert.equal(sent, 1, "暂停期间不许再碰 notifier");

  markOutreachReplied(root, { now: at(18, 30) });
  const sameDay = await runCompanionNudge(env(at(19)));
  assert.equal(sameDay.ok, false);
  assert.equal(sameDay.reason, "quota_medium", "久不互动属 medium，一天只给 1 条（取更严）");
  const nextDay = await runCompanionNudge(env(at(19, 0, 10)));
  assert.equal(nextDay.ok, true, "换一天配额重置，可以再说一句");
  assert.equal(sent, 2);
});

test("接线：未闭环事项在死夜不催，而且不消耗「催过几次」", async () => {
  const { sweepProactive, readState } = await import("../../engine/proactive-manager.mjs");
  const root = ws();
  const job = { id: "j1", label: "渲染 45s", done: true, exitCode: 1, startedAt: at(2, 0, 10), updatedAt: at(2, 0, 10) };

  const base = sweepProactive({ wsRoot: root, detached: [], now: at(15) });
  assert.equal(base.baseline, true);

  const night = sweepProactive({ wsRoot: root, detached: [job], now: at(3, 0, 10) });
  assert.equal(night.nudged.length, 0, "凌晨三点不该催");
  assert.ok(night.heldByPolicy >= 1);
  assert.equal(readState(root).loops["job:j1"]?.attempts ?? 0, 0, "没推就不算催过，下一轮还能追");

  const morning = sweepProactive({ wsRoot: root, detached: [job], now: at(9, 0, 10) });
  assert.equal(morning.nudged.length, 1, "白天照常追");
  const journal = readOutreach(root);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].trigger, "open_loop");
  assert.equal(journal[0].topic, "job:j1");
});
