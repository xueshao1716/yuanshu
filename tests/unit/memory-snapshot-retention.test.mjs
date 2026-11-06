// 记忆快照保留策略 / 写入侧去重 测试
// 背景（2026-09-14 排查）：
//   1) saveSnapshot 原先在 server.mjs 启动块里被 archiveStateSections 无条件调用，
//      每次重启落一份（每份内嵌 记忆日志.md 全文）→ 攒到 521 份 / 98.7MB，且全仓无读取方。
//   2) server.mjs 里"每 20 次对话存一份"读的是 listSnapshots().length % 20：
//      0 触发后份数恒为 1，1..19 都不满足条件 → 该分支第一次之后永远进不去（死代码）。
//   3) autoMemorize 的项目信号连 assistantMsg 一起匹配，"完成/搞定"在助手回复里几乎是口头禅
//      → 几乎每轮追加一条流水账。
// 运行：node --test tests/unit/memory-snapshot-retention.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveStateSections,
  saveSnapshot,
  listSnapshots,
  pruneSnapshots,
  tickSnapshot,
  autoMemorize,
  loadRecentMemory,
  memoryPaths,
  restoreSnapshot,
  SNAPSHOT_KEEP,
} from "../../engine/memory.mjs";
import { pruneLogBackups } from "../../engine/memory/gardener.mjs";

function mkws() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-mem-snap-"));
}
function stateSection(day) {
  return `## 当前状态（2026-09-${day}）\n- 状态行${day}\n`;
}
const cleanups = [];
function ws() { const d = mkws(); cleanups.push(d); return d; }

describe("记忆快照：写入只在真改动时发生", () => {
  test("没有状态节需要归档时，不产生任何快照（P0 回归锁）", () => {
    const w = ws();
    fs.writeFileSync(path.join(w, "记忆.md"), `# 固定记忆\n\n${stateSection("01")}${stateSection("02")}\n`);
    const r = archiveStateSections(w, 5);
    assert.equal(r.ok, true);
    assert.equal(r.archived, 0, "没有超出上限的状态节就不该有归档动作");
    assert.equal(listSnapshots(w).length, 0, "纯读不该留下快照——这正是 98.7MB 堆积的成因");
  });

  test("确有归档时先存快照再改写固定记忆", () => {
    const w = ws();
    const days = ["01", "02", "03", "04", "05", "06", "07"];
    fs.writeFileSync(path.join(w, "记忆.md"), `# 固定记忆\n\n${days.map(stateSection).join("")}`);
    const r = archiveStateSections(w, 5);
    assert.equal(r.archived, 2, `7 个状态节保留 5 个，应归档 2 个（实际 ${r.archived}）`);
    assert.equal(listSnapshots(w).length, 1, "归档前应留 1 份可回退快照");
    const fixed = fs.readFileSync(path.join(w, "记忆.md"), "utf8");
    assert.equal((fixed.match(/（已归档）/g) || []).length, 2, "被归档的节应打上已归档标记");
  });

  test("同一秒内的两次快照不互相覆盖（id 唯一）", () => {
    const w = ws();
    fs.writeFileSync(path.join(w, "记忆.md"), "# 固定记忆\n");
    const a = saveSnapshot(w, "pre-restore");
    const b = saveSnapshot(w, "archive-before");
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.id, b.id, "id 只到分钟时第二次会静默盖掉第一次");
    assert.equal(listSnapshots(w).length, 2);
  });
});

describe("记忆快照：保留上限", () => {
  test("按份数保留最新，删最旧", () => {
    const w = ws();
    const d = path.join(w, "记忆", "快照");
    fs.mkdirSync(d, { recursive: true });
    for (let i = 1; i <= 40; i++) {
      fs.writeFileSync(path.join(d, `202609${String(i).padStart(2, "0")}_120000.json`), "{}");
    }
    const r = pruneSnapshots(w, { keep: 10, maxBytes: 1 << 30 });
    assert.equal(r.kept, 10);
    assert.equal(r.removed, 30);
    const left = listSnapshots(w);
    assert.equal(left.length, 10);
    assert.ok(left[0].startsWith("20260940"), "新的在前，最新一份应保留");
    assert.ok(!left.includes("20260901_120000.json"), "最旧的应被删除");
  });

  test("总字节超限时从最旧端继续截断，且至少留 1 份", () => {
    const w = ws();
    const d = path.join(w, "记忆", "快照");
    fs.mkdirSync(d, { recursive: true });
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(d, `2026090${i}_120000.json`), "x".repeat(1000));
    }
    const r = pruneSnapshots(w, { keep: 100, maxBytes: 2500 });
    assert.ok(r.kept >= 1, "至少保留 1 份，不能清空安全网");
    assert.ok(r.bytes <= 2500, `保留字节应受控，实际 ${r.bytes}`);
    const r2 = pruneSnapshots(ws(), { keep: 100, maxBytes: 0 });
    assert.equal(r2.kept, 0, "目录为空时无事可做");
  });

  test("默认上限是有限值（防止再次无界增长）", () => {
    assert.ok(Number.isFinite(SNAPSHOT_KEEP) && SNAPSHOT_KEEP > 0);
    assert.ok(SNAPSHOT_KEEP <= 100, "默认保留份数应是小数量级");
  });
});

describe("每 N 轮快照：计数器修复死分支", () => {
  test("tickSnapshot 每 N 轮才落一份，且能反复触发", () => {
    const w = ws();
    fs.writeFileSync(path.join(w, "记忆.md"), "# 固定记忆\n");
    const saved = [];
    for (let i = 1; i <= 6; i++) saved.push(tickSnapshot(w, 3).saved);
    assert.deepEqual(saved, [false, false, true, false, false, true],
      "应原样每 3 轮触发一次；旧实现在第一次后永远进不去");
    assert.equal(listSnapshots(w).length, 2);
  });

  test("tickSnapshot 计数器落盘，跨调用保持", () => {
    const w = ws();
    fs.writeFileSync(path.join(w, "记忆.md"), "# 固定记忆\n");
    assert.equal(tickSnapshot(w, 5).ticked, 1);
    assert.equal(tickSnapshot(w, 5).ticked, 2);
    assert.equal(tickSnapshot(w, 5).ticked, 3);
  });
});

describe("autoMemorize：写入侧收紧信号 + 去重", () => {
  test("助手侧“已完成/搞定”这类口头禅不再触发写入", () => {
    const w = ws();
    const r = autoMemorize(w, { userMsg: "你好", assistantMsg: "任务已完成，全部搞定，做好了。" });
    assert.equal(r.wrote, false, "助手复述式完成语不是项目进展，不该灌进日志");
    assert.equal(loadRecentMemory(w, 5).length, 0);
  });

  test("助手侧真正的里程碑仍会记录", () => {
    const w = ws();
    const r = autoMemorize(w, { userMsg: "跑一下发布", assistantMsg: "已发布到生产，测试全绿。" });
    assert.equal(r.wrote, true, "可核查的里程碑应保留");
    assert.ok(loadRecentMemory(w, 5).length === 1);
  });

  test("用户侧偏好/项目信号照旧生效", () => {
    const w = ws();
    assert.equal(autoMemorize(w, { userMsg: "记住，以后统一用深色科技风", assistantMsg: "好的。" }).wrote, true);
    assert.equal(autoMemorize(w, { userMsg: "新项目完成交付", assistantMsg: "收到。" }).wrote, true);
    assert.equal(loadRecentMemory(w, 5).length, 2);
  });

  test("最近 3 条已有同样要点时不重复追加", () => {
    const w = ws();
    const msg = { userMsg: "记住，以后统一用深色科技风", assistantMsg: "好的，已记住这个偏好。" };
    assert.equal(autoMemorize(w, msg).wrote, true);
    const again = autoMemorize(w, msg);
    assert.equal(again.wrote, false, "同样要点应被写入侧去重拦下");
    assert.match(String(again.reason), /重复/);
    assert.equal(loadRecentMemory(w, 5).length, 1);
  });
});

describe(".bak 备份保留上限", () => {
  test("只保留最新 N 份日志备份", () => {
    const w = ws();
    const dir = path.dirname(memoryPaths(w).log);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 8; i++) {
      fs.writeFileSync(path.join(dir, `记忆日志.md.bak-2026-08-26T10-4${i}-00`), "old");
    }
    const r = pruneLogBackups(w, 5);
    assert.equal(r.removed, 3);
    assert.equal(r.kept, 5);
    const left = fs.readdirSync(dir).filter((f) => f.includes(".bak-")).sort();
    assert.equal(left.length, 5);
    assert.ok(left[left.length - 1].includes("10-48"), "最新的一份应保留");
  });
});

describe("快照回退往返（本次把 restoreSnapshot 接上了 API，行为要锁死）", () => {
  test("回退把固定记忆与日志还原到快照时刻", () => {
    const w = ws();
    const fixed = path.join(w, "记忆.md");
    const log = memoryPaths(w).log;
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(fixed, "# 固定记忆\n\n## 核心约定\n- 原始约定\n");
    fs.writeFileSync(log, "### 2026-09-01 10:00\n- 原始日志\n");
    const snap = saveSnapshot(w, "manual");
    assert.equal(snap.ok, true);

    // 之后记忆被改坏
    fs.writeFileSync(fixed, "# 固定记忆\n\n## 核心约定\n- 被改坏的约定\n");
    fs.writeFileSync(log, "### 2026-09-02 10:00\n- 被改坏的日志\n");

    const r = restoreSnapshot(w, snap.id);
    assert.equal(r.ok, true, `回退应成功：${JSON.stringify(r)}`);
    assert.match(fs.readFileSync(fixed, "utf8"), /原始约定/);
    assert.doesNotMatch(fs.readFileSync(fixed, "utf8"), /被改坏的约定/);
    assert.match(fs.readFileSync(log, "utf8"), /原始日志/);
  });

  test("回退不存在的快照返回失败而不是抛错", () => {
    const w = ws();
    const r = restoreSnapshot(w, "20200101_000000");
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /不存在/);
  });
});

test.after(() => {
  for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
