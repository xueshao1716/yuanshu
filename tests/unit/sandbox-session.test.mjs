// 会话级沙箱模式测试：预设 / append-only 日志 / 收紧与放宽的不对称 / plan 模式只能更严
// 运行：node --test tests/unit/sandbox-session.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SANDBOX_PRESETS, DEFAULT_PRESET, recordSandboxMode, effectiveSandboxPreset,
  effectiveSandboxMode, readSandboxLog, sandboxModeView, sandboxSessionPaths, GLOBAL_SCOPE,
} from "../../engine/sandbox-session.mjs";
import { SANDBOX_MODES, sandboxRank } from "../../engine/yuanshu-sandbox.mjs";

const cleanups = [];
function dir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-sbx-")); cleanups.push(d); return d; }
const rec = (d, sid, preset, extra = {}) => recordSandboxMode(d, sid, { preset, ...extra });

describe("默认值：刻意与 dsh 不同（回归锁）", () => {
  test("默认是 standard（workspace-write），不是 dsh 部署的 read-only", () => {
    // 改成 read-only 会让这条挂掉——改之前请先读 sandbox-session.mjs 文件头的三条理由：
    // 阶梯只管 yuanshu 这条路、无人值守会 fail-closed 停住长任务、workspace-write 本身不宽松。
    assert.equal(DEFAULT_PRESET, "standard");
    assert.equal(SANDBOX_PRESETS[DEFAULT_PRESET].mode, "workspace-write");
  });

  test("预设是具名的，且都落在合法阶梯上", () => {
    for (const [id, p] of Object.entries(SANDBOX_PRESETS)) {
      assert.ok(SANDBOX_MODES.includes(p.mode), `${id} 的模式必须在阶梯里`);
      assert.ok(p.label && p.desc, `${id} 要有 label 与说明（不能只给一个裸值）`);
    }
  });

  test("没有任何预设是排序之外的野生值", () => {
    const ranks = Object.values(SANDBOX_PRESETS).map((p) => sandboxRank(p.mode));
    assert.deepEqual([...new Set(ranks)].sort(), [0, 1, 2], "三档应各有一个预设");
  });
});

describe("fold：最新一条生效", () => {
  test("没有记录就是默认预设", () => {
    const d = dir();
    assert.equal(effectiveSandboxPreset(d, "s1").preset, "standard");
    assert.equal(effectiveSandboxMode(d, "s1"), "workspace-write");
  });

  test("同一作用域多次切换，最后一条生效", () => {
    const d = dir();
    rec(d, "s1", "cautious");
    rec(d, "s1", "standard", { reason: "要它改文件了" });
    assert.equal(effectiveSandboxPreset(d, "s1").preset, "standard");
    assert.equal(readSandboxLog(d).filter((e) => e.sessionId === GLOBAL_SCOPE).length, 2, "append-only：不覆盖旧记录");
  });

  test("全局生效：在哪个会话改的，所有会话都读到同一档", () => {
    const d = dir();
    rec(d, "s1", "trusted", { reason: "要动工作区外" });
    assert.equal(effectiveSandboxMode(d, "s1"), "danger-full-access");
    assert.equal(effectiveSandboxMode(d, "s2"), "danger-full-access");
    assert.equal(readSandboxLog(d)[0].viaSession, "s1", "审计里仍记得是从哪个会话改的");
  });

  test("老日志里按会话记的放宽不再生效（只会更严，不会更宽）", () => {
    const d = dir();
    fs.mkdirSync(sandboxSessionPaths(d).dir, { recursive: true });
    fs.writeFileSync(sandboxSessionPaths(d).log, JSON.stringify({ sessionId: "old", preset: "trusted", mode: "danger-full-access", at: "2026-10-01T00:00:00.000Z" }) + "\n");
    assert.equal(effectiveSandboxMode(d, "old"), "workspace-write");
  });
});

describe("收紧与放宽不对称：放宽必须给理由", () => {
  test("收紧不需要理由", () => {
    const d = dir();
    const r = rec(d, "s1", "cautious");
    assert.equal(r.ok, true);
    assert.equal(r.entry.widening, false);
    assert.equal(effectiveSandboxMode(d, "s1"), "read-only");
  });

  test("放宽没理由 → 拒绝，且日志一行都没写", () => {
    const d = dir();
    const r = rec(d, "s1", "trusted");
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /必须写明理由/);
    assert.equal(readSandboxLog(d).length, 0, "被拒的切换不该留下记录");
    assert.equal(effectiveSandboxMode(d, "s1"), "workspace-write");
  });

  test("放宽给了理由 → 写入并生效，理由留在审计里", () => {
    const d = dir();
    const r = rec(d, "s1", "trusted", { reason: "要把产物同步到工作区外" });
    assert.equal(r.ok, true);
    assert.equal(r.entry.widening, true);
    assert.match(String(r.entry.reason), /工作区外/);
    assert.equal(effectiveSandboxMode(d, "s1"), "danger-full-access");
    assert.equal(r.entry.origin, "human", "默认来源是人类点击");
  });

  test("未知预设被拒，并列出可用项", () => {
    const d = dir();
    const r = rec(d, "s1", "yolo");
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /未知预设/);
    assert.match(String(r.reason), /standard/);
  });

  test("不带会话也能改（全局）", () => {
    assert.equal(recordSandboxMode(dir(), "", { preset: "standard" }).ok, true);
  });
});

describe("plan 模式只能更严，不能更宽", () => {
  test("会话已放开到 trusted，进入 plan 仍强制 read-only", () => {
    const d = dir();
    rec(d, "s1", "trusted", { reason: "需要动工作区外" });
    assert.equal(effectiveSandboxMode(d, "s1"), "danger-full-access");
    assert.equal(effectiveSandboxMode(d, "s1", { planLock: true }), "read-only", "计划模式不能借用会话的放宽");
  });
});

describe("日志健壮性", () => {
  test("坏行不丢整份日志", () => {
    const d = dir();
    rec(d, "s1", "cautious");
    fs.appendFileSync(sandboxSessionPaths(d).log, "{不是 json\n\n");
    rec(d, "s1", "standard", { reason: "改回去" });
    assert.equal(readSandboxLog(d).length, 2);
    assert.equal(effectiveSandboxPreset(d, "s1").preset, "standard");
  });

  test("台前视图：当前模式 + 可用预设 + 变化史（新的在前）", () => {
    const d = dir();
    rec(d, "s1", "cautious");
    rec(d, "s1", "standard", { reason: "要动手了" });
    const v = sandboxModeView(d, "s1");
    assert.equal(v.preset, "standard");
    assert.equal(v.mode, "workspace-write");
    assert.equal(v.defaultPreset, "standard");
    assert.equal(v.presets.length, 3);
    assert.equal(v.history.length, 2);
    assert.equal(v.history[0].preset, "standard", "最新一条在最前");
    assert.equal(v.history[1].preset, "cautious");
  });
});

test.after(() => {
  for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
