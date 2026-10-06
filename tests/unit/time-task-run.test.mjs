import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  yesterdayYmd,
  collectTimeTaskBrief,
  buildTimeTaskPrompt,
  timeTaskReadTools,
} from "../../engine/time-task-run.mjs";

test("yesterdayYmd 取本地昨天", () => {
  assert.equal(yesterdayYmd(new Date(2026, 8, 7, 0, 0, 8)), "2026-09-06");
});

test("brief 收录昨日会话和记忆日志，不收录更早的会话", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "time-task-"));
  fs.mkdirSync(path.join(root, "记忆"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆", "记忆日志.md"), [
    "## 2026-09-06 记忆现行作废",
    "- 写入口 upsertMemoryFact",
    "## 2026-09-05 旧事",
    "- 不该进昨日摘录",
    "",
  ].join("\n"));
  const brief = collectTimeTaskBrief({
    wsRoot: root,
    now: new Date(2026, 8, 7, 0, 0, 8),
    sessions: [
      { name: "引擎横评", updatedAt: new Date(2026, 8, 6, 15, 0, 0).toISOString(), preview: "元枢 9/10" },
      { name: "更早闲聊", updatedAt: new Date(2026, 8, 4, 10, 0, 0).toISOString(), preview: "你好" },
    ],
  });
  assert.equal(brief.ymd, "2026-09-06");
  assert.ok(brief.sessionLines.some((l) => l.includes("引擎横评") && l.includes("元枢 9/10")));
  assert.ok(!brief.sessionLines.some((l) => l.includes("更早闲聊")));
  assert.ok(brief.memoryClip.includes("upsertMemoryFact"));
  assert.ok(!brief.memoryClip.includes("不该进昨日摘录"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("prompt 带真实材料，并禁止填空框架", () => {
  const prompt = buildTimeTaskPrompt(
    { prompt: "每日0点对自己前一日的工作，成长进行复盘反思" },
    { ymd: "2026-09-06", sessionLines: ["- 引擎横评｜元枢 9/10"], memoryClip: "- upsertMemoryFact" },
  );
  assert.ok(prompt.includes("每日0点对自己前一日的工作"));
  assert.ok(prompt.includes("引擎横评"));
  assert.ok(prompt.includes("upsertMemoryFact"));
  assert.ok(prompt.includes("禁止") && (prompt.includes("填空") || prompt.includes("框架")));
});

test("定时任务只给只读工具", () => {
  const tools = timeTaskReadTools([
    { type: "function", function: { name: "read" } },
    { type: "function", function: { name: "bash" } },
    { type: "function", function: { name: "write" } },
    { type: "function", function: { name: "web_search" } },
  ]);
  assert.deepEqual(tools.map((t) => t.function.name).sort(), ["read", "web_search"]);
});

test("server 定时任务注入材料并只挂只读工具", () => {
  const src = fs.readFileSync(new URL("../../server.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("composeTimeTaskMessages"));
  assert.ok(src.includes("timeTaskReadTools"));
  assert.ok(!src.includes("请直接执行并输出结果，不要反问"));
});

test("复盘只吃伙伴真实参与的会话，正文名额按消息量分配", async () => {
  const { reflectableSessions } = await import("../../engine/time-task-run.mjs");
  const at = new Date(2026, 9, 6, 15, 0, 0).toISOString();
  const list = reflectableSessions([
    { name: "长对话", group: "workspace", messageCount: 40, updatedAt: at },
    { name: "微信·abc", group: "wechat", messageCount: 6, updatedAt: at },
    { name: "[真测] ping", group: "test", messageCount: 2, updatedAt: at },
    { name: "subagent-worker", group: "foreign", messageCount: 9, updatedAt: at },
    { name: "hi", group: "workspace", messageCount: 1, updatedAt: at },
    { name: "老数据没有 group", messageCount: 3, updatedAt: at },
  ]);
  assert.deepEqual(list.map((s) => s.name), ["长对话", "微信·abc", "老数据没有 group"]);
  const brief = collectTimeTaskBrief({ wsRoot: os.tmpdir(), now: new Date(2026, 9, 7, 0, 0, 8), sessions: list });
  assert.ok(brief.sessionLines.some((l) => l.startsWith("- [微信] 微信·abc")));
});

test("挂账全列并按新旧分段，挂超 7 天的要求逐条给结论", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "time-task-"));
  fs.mkdirSync(path.join(root, "记忆"), { recursive: true });
  const day = 86400000;
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ id: `r_${i}`, at: new Date(Date.now() - (i < 6 ? 20 : 2) * day).toISOString(), sessionId: "reflect", text: `行动${i}`, kind: i % 2 ? "ask" : "fix", status: "pending" });
  fs.writeFileSync(path.join(root, "记忆", "承诺兑现.json"), JSON.stringify(rows));
  const brief = collectTimeTaskBrief({ wsRoot: root, sessions: [] });
  assert.match(brief.commitments, /仍挂着（12）/);
  assert.match(brief.commitments, /近 7 天（6）/);
  assert.match(brief.commitments, /挂超 7 天（6，必须逐条给结论）/);
  for (let i = 0; i < 12; i++) assert.ok(brief.commitments.includes(`行动${i}`), `行动${i} 不能被截掉`);
  assert.match(buildTimeTaskPrompt({}, { ymd: "2026-10-06", commitments: brief.commitments }), /建议作废：/);
  fs.rmSync(root, { recursive: true, force: true });
});
