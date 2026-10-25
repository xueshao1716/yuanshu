// 「自己找活」：每天生成建议（承诺/牵挂/久未推进的定时任务/随口提过的事），打分排序，采纳进牵挂
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  curateIdeas, readIdeas, ideasLine, acceptIdea, dismissIdea,
  findDeferredMentions, scoreIdea, MAX_IDEAS, IDEAS_TTL_MS,
} from "../../engine/idea-curator.mjs";

function tmpWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ideas-"));
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  return root;
}
const now = Date.parse("2026-10-25T22:00:00+08:00");

test("种子：承诺最该做，随口提的次之", () => {
  const ws = tmpWs();
  const doc = curateIdeas({
    wsRoot: ws, now,
    promises: [{ id: "p1", text: "把宣传片交付给小语", at: new Date(now - 86400000).toISOString(), due: true }],
    lingxi: [{ id: "l1", text: "接一个能自动出海报的技能", at: new Date(now - 3600000).toISOString(), status: "new" }],
    tasks: [],
    texts: [],
  });
  assert.ok(doc.items.length >= 1);
  const top = doc.items[0];
  assert.equal(top.kind, "promise", "答应过的事应该排最前");
  assert.ok(top.score >= 0.7);
  assert.match(top.reason, /答应过/);
});

test("从对话里捞'改天再说'这类没落地的句子", () => {
  const mentions = findDeferredMentions([
    { text: "那个海报我改天再弄吧，今天太晚了", at: now },
    { text: "今天天气不错", at: now },
  ], { now });
  assert.equal(mentions.length, 1);
  assert.match(mentions[0].text, /改天/);
});

test("久未推进的定时任务会进候选，最近跑过的不进", () => {
  const ws = tmpWs();
  const old = new Date(now - 10 * 86400000).toISOString();
  const fresh = new Date(now - 3600000).toISOString();
  const doc = curateIdeas({
    wsRoot: ws, now, force: true,
    tasks: [
      { id: "t1", label: "每周整理记忆", lastRun: old },
      { id: "t2", label: "每日复盘", lastRun: fresh },
    ],
  });
  const labels = doc.items.map((x) => x.text).join(" | ");
  assert.match(labels, /整理记忆/, "十天没跑的任务应该提");
  assert.doesNotMatch(labels, /每日复盘/, "一小时前跑过的不该提");
});

test("同一天重复调用不重复生成（幂等）", () => {
  const ws = tmpWs();
  const a = curateIdeas({ wsRoot: ws, now, promises: [{ id: "p", text: "做一件事", at: new Date(now).toISOString() }] });
  const b = curateIdeas({ wsRoot: ws, now: now + 1000, promises: [{ id: "p2", text: "另一件事", at: new Date(now).toISOString() }] });
  assert.equal(b.skipped, "already_today");
  assert.deepEqual(a.items.map((x) => x.id), b.items.map((x) => x.id), "当天不再变");
});

test("最多 3 条，且按分数降序", () => {
  const ws = tmpWs();
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, text: `答应过的事 ${i}`, at: new Date(now - i * 3600000).toISOString(), due: i % 2 === 0 }));
  const doc = curateIdeas({ wsRoot: ws, now, promises: many, force: true });
  assert.equal(doc.items.length, MAX_IDEAS);
  for (let i = 1; i < doc.items.length; i++) assert.ok(doc.items[i - 1].score >= doc.items[i].score);
});

test("采纳 → 进牵挂台账并从建议里移走；不要 → 当天不再出现", () => {
  const ws = tmpWs();
  const doc = curateIdeas({ wsRoot: ws, now, promises: [{ id: "p1", text: "把海报做完", at: new Date(now).toISOString() }] });
  const id = doc.items[0].id;
  const added = [];
  const r = acceptIdea({ wsRoot: ws, id, addLingXi: (root, payload) => { added.push(payload); return { id: "lx1" }; } });
  assert.equal(r.ok, true);
  assert.equal(added.length, 1);
  assert.match(added[0].note, /采纳/);
  assert.equal(readIdeas(ws).items.length, 0);

  const doc2 = curateIdeas({ wsRoot: ws, now, promises: [{ id: "p2", text: "另一件事", at: new Date(now).toISOString() }], force: true });
  const dismissed = dismissIdea({ wsRoot: ws, id: doc2.items[0].id, now });
  assert.equal(dismissed.ok, true);
  assert.equal(readIdeas(ws).items.length, 0);
});

test("环境事实那句：当天有效，过期不提示", () => {
  const ws = tmpWs();
  curateIdeas({ wsRoot: ws, now, promises: [{ id: "p1", text: "把海报做完", at: new Date(now).toISOString() }] });
  const line = ideasLine(ws, { now });
  assert.match(line, /今日建议/);
  assert.match(line, /海报/);
  // 一天半以后不提示
  assert.equal(ideasLine(ws, { now: now + IDEAS_TTL_MS + 1000 }), "");
});

test("打分三维都在 0..1，且可行性权重最高", () => {
  const lo = scoreIdea({ kind: "deferred", text: "随便一句话", at: now - 30 * 86400000 }, { now, tags: [] });
  const hi = scoreIdea({ kind: "promise", text: "答应的事", at: now, hasDeadline: true, repeat: 2 }, { now, tags: ["答应"] });
  assert.ok(lo.score < hi.score);
  for (const v of Object.values(hi.parts)) assert.ok(v >= 0 && v <= 1);
});
