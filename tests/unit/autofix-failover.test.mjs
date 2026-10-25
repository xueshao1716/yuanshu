// 「自动执行」三条全失败的真因：执行轮裸调 defaultModel，主通道 402 就整条记失败。
// 这里钉两件事：代码里不许再有裸调；402 必须触发通道切换。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { withModelFailover } from "../../engine/model-failover.mjs";

const src = fs.readFileSync(new URL("../../server.mjs", import.meta.url), "utf8");

test("无人看着跑的执行轮都走 chatWithFailover，不再裸调 defaultModel", () => {
  assert.match(src, /async function chatWithFailover\(/, "要有统一的切换器");
  // 只看代码行，注释里提到旧写法不算
  const bare = src.split("\n")
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => /unifiedChat\(defaultModel/.test(line) && !/^\s*(\*|\/\/)/.test(line));
  assert.deepEqual(bare, [], `还有裸调：${bare.map((b) => b.i).join(",")}`);
  // 时间引擎的执行轮（2026-10-25 出事的那处）
  assert.match(src, /const turn = \(tools\) => async \(prompt\) => \{[\s\S]{0,400}?chatWithFailover\(/, "时间引擎执行轮要切换");
  // 当场修（fix_problem）与候选生成
  const fixSites = src.match(/runTurn: runFixTurn/g) || [];
  assert.equal(fixSites.length, 2, "fix_problem 与 setOnTheSpotFixRunner 两处都要用 runFixTurn");
});

test("HTTP 402 会被当成额度问题并换通道，不是直接失败", async () => {
  const tried = [];
  const out = await withModelFailover({
    initial: { provider: "deepseek", id: "deepseek-flash" },
    call: async (model) => {
      tried.push(`${model.provider}/${model.id}`);
      if (model.provider === "deepseek") throw new Error("HTTP 402: Insufficient Balance (request_id: x)");
      return { text: "换到这个通道就成了" };
    },
    pickNext: () => ({ provider: "agnes", id: "agnes-2.5-flash" }),
  });
  // withModelFailover 返回 {result, model, attempts, tried}：调用方必须取 .result，
  // 这条断言本身就是在钉这个包装形状（server 的 chatWithFailover 已按此拆包）。
  assert.equal(out.result.text, "换到这个通道就成了");
  assert.equal(out.model.id, "agnes-2.5-flash", "要报出最后用的是哪个通道");
  assert.deepEqual(tried, ["deepseek/deepseek-flash", "agnes/agnes-2.5-flash"], "先撞 402 再换，两次都要试到");
});

test("402 被归类为额度类失败（决定还要不要把希望寄托在这个通道）", async () => {
  const { classifyModelFailure } = await import("../../engine/model-failover.mjs");
  const kind = classifyModelFailure(new Error("HTTP 402: Insufficient Balance"));
  assert.equal(kind, "quota", `402 应归为额度类，实际 ${kind}`);
});
