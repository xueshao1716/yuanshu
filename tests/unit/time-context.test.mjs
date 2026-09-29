// 时间上下文：从「时钟」到「时间感」（engine/yuanshu-seams.mjs）
//
// 原来有三份重复实现（yuanshu-seams.promptTimeText / time-engine.nowContext / server.mjs 内联），
// 而 nowContext 全仓零调用者是死代码。三份都只说"现在几点"——是时钟，不是时间感。
// 现在统一成 promptTimeText，并补上"过了多久"：隔三天回来和刚聊完接着聊，
// 语气与判断本来就该不一样。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { promptTimeText, sincePhrase, durationPhrase } from "../../engine/yuanshu-seams.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const NOW = new Date("2026-09-14T22:30:00");
const ago = ms => NOW.getTime() - ms;

test("只有时钟时不多说：没有 since 就不该出现「时间感」", () => {
  const t = promptTimeText(NOW);
  assert.match(t, /当前时间：2026-09-14 22:30（周一）/);
  assert.ok(!t.includes("时间感"), "没有「过了多久」的数据就别说");
});

test("距上次对话：各档位措辞自然，且不出现「距…前」叠词", () => {
  const cases = [
    [30 * 1000, /上次对话就在刚刚/],
    [20 * 60000, /距上次对话 20 分钟/],
    [3 * 3600_000, /距上次对话 3 小时/],
    [3 * 86400_000, /距上次对话 3 天/],
    [70 * 86400_000, /距上次对话 2 个月/],
    [800 * 86400_000, /距上次对话 2 年/],
  ];
  for (const [delta, re] of cases) {
    const line = promptTimeText(NOW, { since: ago(delta) });
    assert.match(line, re, `${delta}ms 的措辞不对: ${line}`);
    assert.ok(!/距上次对话[^；。]*前[；。]/.test(line), `不该出现"距…前"叠词: ${line}`);
  }
});

test("会话持续时长：单独一行，且不写「3 天 0 小时」这种 0 分量", () => {
  assert.match(promptTimeText(NOW, { sessionStart: ago(90 * 60000) }), /本次会话已持续 1 小时 30 分钟/);
  assert.match(promptTimeText(NOW, { sessionStart: ago(2 * 86400_000) }), /本次会话已持续 2 天(?!\s*0)/);
  assert.match(promptTimeText(NOW, { sessionStart: ago(30 * 1000) }), /本次会话已持续 不到 1 分钟/);
});

test("两个维度可以同时出现，顺序是先「距上次」后「已持续」", () => {
  const t = promptTimeText(NOW, { since: ago(3 * 86400_000), sessionStart: ago(90 * 60000) });
  assert.match(t, /距上次对话 3 天；本次会话已持续 1 小时 30 分钟/);
});

test("较久未聊时给出行为提示，避免模型假装刚刚还在聊", () => {
  assert.match(promptTimeText(NOW, { since: ago(3 * 86400_000) }), /不要假装刚刚还在聊/);
});

test("非法/未来时间不崩，也不产生荒谬措辞", () => {
  for (const bad of [0, -1, NaN, Infinity, "abc", null, undefined]) {
    const t = promptTimeText(NOW, { since: bad, sessionStart: bad });
    assert.match(t, /当前时间：2026-09-14 22:30/, `since=${String(bad)} 时应退回纯时钟`);
    assert.ok(!t.includes("时间感"), `since=${String(bad)} 不该编出时间感`);
  }
  // 未来时间（时钟漂移/伪造）不该产生"负多少分钟"
  const future = promptTimeText(NOW, { since: NOW.getTime() + 86400_000 });
  assert.ok(!future.includes("时间感"), "未来时间不产生时间感");
  assert.equal(sincePhrase(-5), "");
  assert.equal(durationPhrase(-5), "");
});

test("now（第一个参数）不是合法 Date 时退回当前时刻而不是崩", () => {
  const t = promptTimeText(new Date("nope"));
  assert.match(t, /当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});

// ── 重复实现已收敛 ──
test("时间格式化只剩一份：死代码 nowContext 已删，server.mjs 不再内联拼时间", () => {
  const timeEngine = read("engine", "time-engine.mjs");
  assert.ok(!/export function nowContext/.test(timeEngine), "nowContext 是零调用者的重复实现，应已删除");

  const server = read("server.mjs");
  // Pi 路径必须用统一实现，并且既带 since（距上次多久）也带 rhythm（观测到的作息）
  assert.match(server, /promptTimeText\(new Date\(\), \{ since: prevTalkAt, rhythm \}\)/, "Pi 路径必须用统一实现并带上 since 与 rhythm");
  assert.ok(!/getFullYear\(\)/.test(server), "server.mjs 不该再内联拼时间字符串");
  // 作息读数必须真的从 activity-rhythm 观测得来，不能在调用点写死
  assert.match(server, /readActivityRhythm\(CONFIG\.cwd/, "作息必须来自真实观测而不是常量");
  assert.ok(!/getFullYear\(\)/.test(server), "server.mjs 不该再内联拼时间字符串");

  const seams = read("engine", "yuanshu-seams.mjs");
  assert.equal((seams.match(/当前时间：/g) || []).length, 1, "时间格式串只应有一处");
});

test("since 必须在 updateEmotion 之前取，否则差值恒为 0", () => {
  const server = read("server.mjs");
  const prev = server.indexOf("const prevTalkAt =");
  const upd = server.indexOf("emotion.updateEmotion(sessKey, emotionInput.message, emotionInput)");
  assert.ok(prev > 0 && upd > 0, "两处都应存在");
  assert.ok(prev < upd, "prevTalkAt 必须取在 updateEmotion 之前（它会把 lastTalk 刷成本轮）");
});
