// 技能 / 工具热度（2026-11-19）：常用的越用越顺——热档工具不被收起、热档技能排前并加分
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initUsageHeat, recordUse, heatScore, heatTier, heatSnapshot, setHeatPref, applyToolHeat, rankSkills, backfillUsageHeat, flushUsageHeat, heatFile, HOT_TOOL_CAP, _resetUsageHeat } from "../../engine/usage-heat.mjs";
import { filterToolsByTier, PROTOCOL_KEEP_TOOLS } from "../../engine/brain-regions.mjs";
import { matchSkillsForTask, formatSkillIndexPrompt } from "../../engine/skill-matcher.mjs";

const T = (name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } });
const names = (ts) => ts.map((t) => t.function.name);
let root;
beforeEach(() => {
  _resetUsageHeat();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "heat-"));
  initUsageHeat({ wsRoot: root });
});
const useN = (kind, name, n, opts = {}) => { for (let i = 0; i < n; i++) recordUse(kind, name, opts); };

test("热度分：常用 + 最近用过 → 热；很久以前用过 → 冷；没用过 → idle", () => {
  useN("tool", "run_code", 12);
  recordUse("tool", "canvas", { at: Date.now() - 50 * 86400_000 });
  const snap = Object.fromEntries(heatSnapshot().items.map((i) => [i.name, i]));
  assert.equal(snap.run_code.tier, "hot");
  assert.equal(snap.run_code.count30, 12);
  assert.equal(snap.canvas.tier, "cold");
  assert.equal(heatTier(0, { used: false }), "idle");
  assert.equal(heatScore(undefined), 0);
});

test("老出错的工具分数更低", () => {
  useN("tool", "a", 4);
  useN("tool", "b", 4, { ok: false });
  const s = Object.fromEntries(heatSnapshot().items.map((i) => [i.name, i.score]));
  assert.ok(s.a > s.b);
});

test("热档工具不再被工具档收起，额外最多 HOT_TOOL_CAP 个；用户收起的拿掉（协议必需的除外）", () => {
  const all = [T("read"), T("bash"), T("run_code"), T("canvas"), ...Array.from({ length: 12 }, (_, i) => T(`mcp_x_${i}`)), T("delegate_task")];
  const kept = filterToolsByTier(all, { tooling: 0.5 });
  assert.ok(!names(kept).includes("run_code"));
  useN("tool", "run_code", 10);
  for (let i = 0; i < 12; i++) useN("tool", `mcp_x_${i}`, 10);
  const out = names(applyToolHeat(all, kept, { protect: PROTOCOL_KEEP_TOOLS }));
  assert.equal(out.length - kept.length, HOT_TOOL_CAP);
  setHeatPref({ kind: "tool", name: "bash", action: "hide" });
  setHeatPref({ kind: "tool", name: "delegate_task", action: "hide" });
  const out2 = names(applyToolHeat(all, kept, { protect: PROTOCOL_KEEP_TOOLS }));
  assert.ok(!out2.includes("bash"));
  assert.ok(out2.includes("delegate_task"), "协议点名的工具不能被收起");
  setHeatPref({ enabled: false });
  assert.deepEqual(names(applyToolHeat(all, kept)), names(kept), "关掉热度回到写死名单");
});

test("钉住的工具即使没用过也算热", () => {
  const all = [T("read"), T("canvas")];
  const kept = filterToolsByTier(all, { tooling: 0.5 });
  setHeatPref({ kind: "tool", name: "canvas", action: "pin" });
  assert.deepEqual(names(applyToolHeat(all, kept)), ["read", "canvas"]);
});

test("热档技能排在目录前面，匹配时只给本来就命中的加分；收起的技能不进目录也不匹配", () => {
  const skills = [{ name: "a-ppt", desc: "做 ppt 幻灯片" }, { name: "b-ppt", desc: "做 ppt 幻灯片" }, { name: "c", desc: "别的" }];
  useN("skill", "b-ppt", 10);
  const ranked = rankSkills(skills);
  assert.equal(ranked[0].name, "b-ppt");
  assert.equal(matchSkillsForTask("帮我做个 ppt", ranked)[0].name, "b-ppt");
  assert.ok(!matchSkillsForTask("今天天气", ranked).some((s) => s.name === "b-ppt"));
  setHeatPref({ kind: "skill", name: "a-ppt", action: "hide" });
  const r2 = rankSkills(skills);
  assert.ok(!matchSkillsForTask("帮我做个 ppt", r2).some((s) => s.name === "a-ppt"));
  assert.doesNotMatch(formatSkillIndexPrompt(r2), /a-ppt/);
});

test("落盘与回填：技能流水 + 运行事件流只回填一次", async () => {
  const ep = path.join(root, "episodes.jsonl");
  fs.writeFileSync(ep, [JSON.stringify({ kind: "skill-match", at: new Date().toISOString(), choice: "s1" }), JSON.stringify({ kind: "other" })].join("\n"));
  const ev = path.join(root, "events");
  fs.mkdirSync(ev);
  fs.writeFileSync(path.join(ev, "r1.jsonl"), [JSON.stringify({ type: "tool_end", ts: new Date().toISOString(), data: { name: "read", durationMs: 20, isError: false } }), JSON.stringify({ type: "tool", data: { name: "read" } })].join("\n"));
  const r = await backfillUsageHeat({ episodesFile: ep, eventsDir: ev });
  assert.deepEqual(r, { skills: 1, tools: 1 });
  assert.equal((await backfillUsageHeat({ episodesFile: ep, eventsDir: ev })).skipped, true);
  flushUsageHeat();
  const saved = JSON.parse(fs.readFileSync(heatFile(root), "utf8"));
  assert.equal(saved.items["tool:read"].count, 1);
  assert.equal(saved.items["tool:read"].totalMs, 20);
  _resetUsageHeat();
  initUsageHeat({ wsRoot: root });
  assert.equal(heatSnapshot().items.find((i) => i.name === "s1").kind, "skill");
});
