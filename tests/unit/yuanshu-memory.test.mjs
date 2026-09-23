import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { YUANSHU_PROTOCOL, buildYuanshuContext } from "../../engine/yuanshu-protocol.mjs";
import { sessionContinuityNote, coachSearchRound, abortedAssistantText } from "../../engine/yuanshu-session.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("有历史就不能说新开的会话；没历史就去读记忆，不要 bash 扫盘", () => {
  assert.match(sessionContinuityNote([{ role: "user", text: "为韩跑跑写个独白" }]), /不是新开/);
  assert.match(sessionContinuityNote([]), /记忆\.md/);
  assert.doesNotMatch(sessionContinuityNote([]), /之前的对话历史没带过来|这个会话是新开的/);
});

test("搜两轮还锁不到人，就按判断写，不要连搜", () => {
  const one = coachSearchRound("web_search", 1, { text: "百科一堆姓韩的" });
  assert.doesNotMatch(one.text, /不要再连搜/);
  const two = coachSearchRound("web_search", 2, { text: "还是百科" });
  assert.match(two.text, /判断|汇报/);
  assert.match(two.text, /连搜|先写|动手/);
});

test("打断也要留下半截正文，没有正文就留停止标记", () => {
  assert.match(abortedAssistantText({ text: "大家好，我是韩跑跑。" }), /韩跑跑/);
  assert.match(abortedAssistantText({ aborted: true }), /停止/);
});

test("协议：创作先判断；问记忆看上下文，不翻盘", () => {
  assert.match(YUANSHU_PROTOCOL, /独白|剧本|创作/);
  assert.match(YUANSHU_PROTOCOL, /判断/);
  assert.match(YUANSHU_PROTOCOL, /记忆\.md/);
  assert.doesNotMatch(YUANSHU_PROTOCOL, /禁止搜索/);
});

test("buildYuanshuContext 要把本会话 continuity 注进去", () => {
  const empty = buildYuanshuContext({ message: "嗯", hist: [] });
  assert.ok(empty.some((s) => /本会话/.test(s) && /记忆\.md/.test(s)));
  const old = buildYuanshuContext({ message: "你怎么记忆断了", hist: [{ role: "user", text: "韩跑跑" }] });
  assert.ok(old.some((s) => /不是新开/.test(s)));
});

test("统一通道必须先落用户原话；打断也要落盘，不能当没说过", () => {
  const src = readFileSync(join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const start = src.indexOf("export async function handleUnifiedChat");
  const fn = src.slice(start, src.indexOf('// Agent 活动事件环', start));
  const persistUserAt = fn.search(/persistYuanshuUser|appendMessage\(\{\s*role:\s*"user"/);
  const chatAt = fn.indexOf("await unifiedChat");
  assert.ok(persistUserAt >= 0 && persistUserAt < chatAt, "用户原话必须在模型开跑之前落盘");
  const abortAt = fn.indexOf("result?.aborted");
  assert.ok(abortAt > 0, "必须处理打断");
  const afterAbort = fn.slice(abortAt, abortAt + 500);
  assert.ok(/appendMessage|persistYuanshu/.test(afterAbort), "打断不能把这轮从会话里抹掉");
});
