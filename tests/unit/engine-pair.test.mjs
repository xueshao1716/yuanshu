import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGINE_CATALOG, DEFAULT_PAIR, normalizePair, saveEnginePair, loadEnginePair, swapEnginePair, resolveLead, initEnginePair, leadNote,
} from "../../engine/engine-pair.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("目录含元枢/pi/dsh，默认主驾是 pi、次席是元枢", () => {
  assert.ok(ENGINE_CATALOG.yuanshu.canLead);
  assert.ok(ENGINE_CATALOG.pi.canLead);
  // dsh 不可主驾：原先这里断言 true，理由是"对话适配器写完后应能主驾"——那是完成度目标，
  // 不是能力判断。实测元枢调用它的方式预热后约 4.7s/轮（每轮新起 headless 子进程），冷启动约 27s，
  // 且无流式、历史只能压成 8×800 字摘要。它的活是执行臂 dsh_task，与 canLead 无关。
  assert.equal(ENGINE_CATALOG.dsh.canLead, false, "dsh 作为执行臂可用，但不作为主驾");
  assert.deepEqual(DEFAULT_PAIR, { primary: "pi", secondary: "yuanshu" });
});

test("不可主驾的引擎放在主驾位时让路，并有可见播报", () => {
  const d = resolveLead({ primary: "dsh", secondary: "yuanshu", force: false, nativeChannel: true });
  assert.equal(d.lead, "yuanshu", "主驾位给了不可主驾的引擎时应回落到次席");
  assert.equal(d.deferred, "dsh");
  assert.equal(d.reason, "cannot-lead");
  assert.match(leadNote(d), /dsh 主驾让路/, "让路必须对用户可见，不能静默换引擎");
});

test("每份引擎必须有介绍和能力边界，不能只剩一句 desc", () => {
  for (const [id, e] of Object.entries(ENGINE_CATALOG)) {
    assert.ok(String(e.intro || "").length >= 20, `${id} 要有介绍`);
    assert.ok(Array.isArray(e.can) && e.can.length >= 2, `${id} 要写能做什么`);
    assert.ok(Array.isArray(e.cannot) && e.cannot.length >= 2, `${id} 要写能力边界`);
  }
  assert.ok(ENGINE_CATALOG.yuanshu.intro.includes("自制") && ENGINE_CATALOG.yuanshu.cannot.some((s) => /默认主驾|评测|HTTP/.test(s)));
  assert.ok(ENGINE_CATALOG.pi.cannot.some((s) => /非原生|兑底|可卸/.test(s)));
  assert.ok(ENGINE_CATALOG.dsh.cannot.some((s) => /记忆|出图|多轮/.test(s)));
});

test("normalizePair 拒绝同名主次和未知 id", () => {
  assert.throws(() => normalizePair({ primary: "pi", secondary: "pi" }), /主次不能相同/);
  assert.throws(() => normalizePair({ primary: "foo", secondary: "yuanshu" }), /未知引擎/);
});

test("落盘后能读回，swap 对调主次", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-engine-pair-"));
  try {
    initEnginePair(join(dir, "engine-pair.json"));
    const saved = saveEnginePair({ primary: "yuanshu", secondary: "dsh" });
    assert.deepEqual(saved, { primary: "yuanshu", secondary: "dsh" });
    assert.deepEqual(loadEnginePair(), saved);
    assert.deepEqual(swapEnginePair(), { primary: "dsh", secondary: "yuanshu" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveLead：能主驾的就按配置走主驾", () => {
  assert.equal(resolveLead({ primary: "pi", secondary: "yuanshu" }).lead, "pi");
  assert.equal(resolveLead({ primary: "yuanshu", secondary: "pi" }).lead, "yuanshu");
  assert.equal(resolveLead({ primary: "yuanshu", secondary: "pi" }).deferred, null);
});

test("非原生通道只逼 pi 兑底元枢；PI_USE_AGENT=0 仍强制元枢；dsh 一律让路", () => {
  assert.equal(resolveLead({ primary: "pi", secondary: "yuanshu" }, { forceYuanshu: true }).lead, "yuanshu");
  assert.equal(resolveLead({ primary: "dsh", secondary: "yuanshu" }, { forceYuanshu: true }).lead, "yuanshu");
  assert.equal(resolveLead({ primary: "pi", secondary: "yuanshu" }, { nativeChannel: false }).lead, "yuanshu");
  // dsh 不可主驾：无论通道是否原生、次席是谁，占了主驾位都让路给能主驾的那个
  assert.equal(resolveLead({ primary: "dsh", secondary: "yuanshu" }, { nativeChannel: false }).lead, "yuanshu");
  assert.equal(resolveLead({ primary: "dsh", secondary: "pi" }).lead, "pi");
});

test("pi SDK 缺失时，保留配置但把实际主驾让给元枢", () => {
  const d = resolveLead({ primary: "pi", secondary: "yuanshu" }, { piAvailable: false });
  assert.equal(d.lead, "yuanshu");
  assert.equal(d.reason, "unavailable");
  assert.equal(d.deferred, "pi");
  assert.match(leadNote(d), /pi 适配器不可用/);
});

test("引擎页能对调主次并写回后台", () => {
  const src = readFileSync(join(ROOT, "frontend", "src", "components", "engine", "EnginePairPanel.tsx"), "utf8");
  assert.ok(src.includes("主引擎"));
  assert.ok(src.includes("次引擎"));
  assert.ok(src.includes("EngineApi.savePair"));
  assert.ok(src.includes("对调主次引擎"));
  assert.ok(src.includes("e.intro") && src.includes("e.can") && src.includes("e.cannot"), "介绍和边界必须来自接口目录，不能前端写死三套文案");
  assert.ok(src.includes("能做") && src.includes("边界"), "每份引擎要能看见能力与边界");
});

test("handleChat 必须按 resolveLead 派单，不能只看环境变量", () => {
  const src = readFileSync(join(ROOT, "server.mjs"), "utf8");
  const start = src.indexOf("async function handleChat");
  const fn = src.slice(start, start + 12000);
  assert.ok(fn.includes("resolveLead"), "主通道必须问引擎主次对");
  assert.ok(fn.includes("loadEnginePair"), "主次对从后台读，不是前端私藏");
});
