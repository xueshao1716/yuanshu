import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beginYuanshuEmotion, endYuanshuEmotion } from "../../engine/yuanshu-emotion.mjs";
import { getSnapshot, clearEmotion } from "../../engine/emotion.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("开轮必须更新 VAD 并把情绪指令注入历史，不能只留给 pi", () => {
  const key = "ys-emo-begin";
  clearEmotion(key);
  const hist = [{ role: "user", content: "你好" }];
  const next = beginYuanshuEmotion(key, "我好烦，这破东西又坏了", hist);
  const snap = getSnapshot(key);
  assert.ok(next.length > hist.length, "必须往历史里加情绪语境");
  assert.ok(next.some((m) => m.role === "system" && /情绪语境/.test(m.content)), "注入头必须是情绪语境");
  assert.ok(typeof snap.valence === "number" && typeof snap.arousal === "number", "VAD 要有数字");
  assert.ok((snap.tags || []).includes("user_frustrated") || /烦躁|共情/.test(next.find((m) => /情绪语境/.test(m.content || ""))?.content || ""), "烦躁要进指令");
});

test("收轮必须落感受并推 emotion，灵珠才能跟元枢走", () => {
  const key = "ys-emo-end";
  clearEmotion(key);
  beginYuanshuEmotion(key, "谢谢你帮我做成了", []);
  const ev = [];
  const es = endYuanshuEmotion(key, "谢谢你帮我做成了", "做成了，交给你。", { push: (t, d) => ev.push({ t, d }) });
  assert.equal(ev[0]?.t, "emotion");
  assert.ok(ev[0]?.d?.state, "SSE 要带 state");
  assert.ok(es && typeof es.valence === "number");
});

test("同一句 10 秒内再开轮不能把关键词加两遍（pi 兑底元枢会再进一次）", () => {
  const key = "ys-emo-once";
  clearEmotion(key);
  beginYuanshuEmotion(key, "我好烦我好烦我好烦", []);
  const a = getSnapshot(key).arousal;
  beginYuanshuEmotion(key, "我好烦我好烦我好烦", []);
  const b = getSnapshot(key).arousal;
  assert.ok(Math.abs(b - a) < 0.02, `兑底重入不应再推唤醒：${a} → ${b}`);
});

test("handleUnifiedChat 必须自己开轮收轮情绪，不能指望 handleChat", () => {
  const src = readFileSync(join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const start = src.indexOf("export async function handleUnifiedChat");
  // 不再用写死的窗口长度：GRN 轮末接线（2026-11-09）把函数撑过了 14000 字，
  // 旧窗口会切在 `await unifiedChat` 之前，把"顺序"断言变成"没找到"。
  // 切到本函数结束（下一个顶级 export 之前）才是这条测试的本意。
  const next = src.indexOf("\nexport {", start + 1);
  const fn = src.slice(start, next > start ? next : src.length);
  assert.ok(fn.includes("beginYuanshuEmotion"), "开轮要接 beginYuanshuEmotion");
  assert.ok(fn.includes("endYuanshuEmotion"), "收轮要接 endYuanshuEmotion");
  const beginAt = fn.indexOf("beginYuanshuEmotion");
  const chatAt = fn.indexOf("await unifiedChat");
  assert.ok(chatAt > 0, "切片里要能找到 await unifiedChat");
  assert.ok(beginAt >= 0 && beginAt < chatAt, "情绪指令必须在模型开跑之前注入");
});

test("收轮必须 flush 人格证据，不能在开轮过阈值就提案", () => {
  const emo = readFileSync(join(ROOT, "engine", "yuanshu-emotion.mjs"), "utf8");
  assert.ok(emo.includes("flushPersonaAttribution"), "endYuanshuEmotion 要冲 pending");
  const server = readFileSync(join(ROOT, "server.mjs"), "utf8");
  const turnAt = server.indexOf("else if (event.type === \"turn_end\")");
  assert.ok(turnAt >= 0, "pi 必须有 turn_end 收轮");
  const turn = server.slice(turnAt, turnAt + 1800);
  assert.ok(turn.includes("flushPersonaAttribution"), "pi turn_end 也要冲 pending");
});
