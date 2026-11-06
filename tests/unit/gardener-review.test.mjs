// 园丁人工处置单测：去重保留最新 + 备份 + 已核对标记（fs 内存桩）
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeLog, markReviewed, getReviewed, unmarkReviewed } from "../../engine/memory/gardener.mjs";

function normPath(p) { return String(p).replace(/\\/g, '/') }
function memFs() {
  const files = new Map();
  return {
    files,
    existsSync: p => files.has(normPath(p)),
    readFileSync: p => { const k = normPath(p); if (!files.has(k)) throw new Error("ENOENT"); return files.get(k); },
    writeFileSync: (p, c) => files.set(normPath(p), String(c)),
    mkdirSync: () => {},
    renameSync: (a, b) => { const ka = normPath(a), kb = normPath(b); const v = files.get(ka); files.delete(ka); if (v !== undefined) files.set(kb, v); },
    unlinkSync: () => {},
  };
}
const WS = "/ws";

const LOG = [
  "### 2026-08-06 10:00",
  "- 要点：部署了新版本",
  "",
  "### 2026-08-20 09:00",
  "- 要点：部署了新版本", // 与上面同要点 → 重复组，保留这条（最新）
  "",
  "### 2026-08-21 12:00",
  "- 要点：独立事件不应被动",
].join("\n");

test("去重：每组保留最新、备份原日志", () => {
  const f = memFs();
  const logPath = "/ws/记忆/记忆日志.md";
  f.writeFileSync(logPath, LOG);
  const r = dedupeLog(WS, f);
  assert.equal(r.removed, 1);
  assert.ok(r.backup.includes(".bak-"));
  // 备份内容 = 原文
  assert.equal(f.files.get(normPath(r.backup)), LOG);
  // 新日志：3 块 → 2 块，且保留的是 08-20 那条
  const kept = f.files.get(logPath);
  assert.ok(kept.includes("2026-08-20"));
  assert.ok(!kept.includes("2026-08-06 10:00"));
  assert.ok(kept.includes("独立事件不应被动")); // 非重复不受影响
});

test("无重复时不写备份直接返回", () => {
  const f = memFs();
  const logPath = "/ws/记忆/记忆日志.md";
  f.writeFileSync(logPath, "### 2026-08-21\n- 要点：唯一一条");
  const r = dedupeLog(WS, f);
  assert.equal(r.removed, 0);
  assert.equal(r.backup, null);
});

test("已核对标记与撤销", () => {
  const f = memFs();
  markReviewed(WS, "dup", "key-a", f);
  markReviewed(WS, "stale", "2026-08-01", f);
  assert.equal(getReviewed(WS, f).length, 2);
  // 同 key 再标不重复追加
  markReviewed(WS, "dup", "key-a", f);
  assert.equal(getReviewed(WS, f).length, 2);
  unmarkReviewed(WS, "dup", "key-a", f);
  const left = getReviewed(WS, f).map(x => x.key);
  assert.deepEqual(left, ["2026-08-01"]);
});
