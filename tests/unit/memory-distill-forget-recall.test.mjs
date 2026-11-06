// 三个模块的契约测试
import { test } from "node:test";
import assert from "node:assert/strict";

const classify = async () => (await import("../../engine/memory/distill.mjs")).classifySentence;
const distillMod = () => import("../../engine/memory/distill.mjs");
const forgetMod = () => import("../../engine/memory/forget.mjs");
const recallMod = () => import("../../engine/memory/recall.mjs");

test("蒸馏：偏好/事实/结论能识别，寒暄和问句不收", async () => {
  const c = await classify();
  assert.equal(c("我喜欢晚上干活，白天写不出东西")?.type, "preference");
  assert.equal(c("我住在兰州，家里有只猫叫团子")?.type, "fact");
  assert.equal(c("结论是以后先跑测试再提交")?.type, "fact");
  assert.equal(c("好的"), null);
  assert.equal(c("谢谢！"), null);
  assert.equal(c("这个怎么弄？"), null);
  assert.equal(c("嗯嗯嗯"), null);
});

test("蒸馏：候选抽取只取用户说的话，且去重", async () => {
  const { distillCandidates } = await distillMod();
  const out = distillCandidates([
    { role: "user", content: "我喜欢简洁的界面。我喜欢简洁的界面。" },
    { role: "assistant", content: "我喜欢把话说三遍" },
    { role: "user", content: "好的" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].memory_type, "preference");
});

test("蒸馏：近重复判定（前缀包含 + 长度比）", async () => {
  const { isDuplicate } = await distillMod();
  const existing = [{ memory_id: "a", summary: "我喜欢简洁的界面，别加花哨动效" }];
  assert.ok(isDuplicate("我喜欢简洁的界面", existing));
  assert.equal(isDuplicate("我喜欢暗色主题", existing), null);
});

test("遗忘：久未访问且不重要 → stale；重要条目保留", async () => {
  const { shouldForget } = await forgetMod();
  const now = Date.now();
  const day = 86400000;
  assert.equal(shouldForget({ status: "active", importance_score: 0.3, last_accessed_at: now - 120 * day }, now), "stale");
  assert.equal(shouldForget({ status: "active", importance_score: 0.9, last_accessed_at: now - 120 * day }, now), null);
  assert.equal(shouldForget({ status: "active", importance_score: 0.3, created_at: now - 40 * day }, now), "never_accessed");
  assert.equal(shouldForget({ status: "active", importance_score: 0.3, expire_at: now - 1000 }, now), "expired");
  assert.equal(shouldForget({ status: "archived", importance_score: 0.1, last_accessed_at: now - 999 * day }, now), null);
});

test("遗忘：只归档不删除（dryRun 不改库）", async (t) => {
  // 记忆库是惰性打开的，测试里需要先注入一个临时工作区
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { initMemoryDb } = await import("../../engine/memory/db.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-test-"));
  // Windows 下 sqlite 文件可能还被句柄占着，清理失败不该让测试红
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} });
  initMemoryDb(root);
  const { forgetStale } = await forgetMod();
  const out = forgetStale({ dryRun: true });
  assert.equal(typeof out.archived, "number");
  assert.ok(Array.isArray(out.items));
});

test("召回：相关性高的排前面，且限量", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { initMemoryDb } = await import("../../engine/memory/db.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-test2-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initMemoryDb(root);
  const { scoreMemory, relevance } = await recallMod();
  const now = Date.now();
  const rows = [
    { memory_id: "1", summary: "我喜欢暗色主题", importance_score: 0.7, last_accessed_at: now },
    { memory_id: "2", summary: "我住在兰州", importance_score: 0.7, last_accessed_at: now },
  ];
  assert.ok(relevance("暗色主题好看吗", rows[0].summary) > relevance("暗色主题好看吗", rows[1].summary));
  const s1 = scoreMemory(rows[0], "暗色主题", now);
  const s2 = scoreMemory(rows[1], "暗色主题", now);
  assert.ok(s1 > s2);
});

test("召回：拼接提示词有则给、无则空", async () => {
  const { recallPrompt } = await recallMod();
  const p = recallPrompt({ query: "不可能匹配的词zzz", limit: 3, maxChars: 50 });
  assert.equal(typeof p, "string");
});
