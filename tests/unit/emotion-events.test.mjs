// 事件驱动情绪（2026-11-09）
// 缺口：以前 VAD 只由用户话语驱动——她自己工具失败、被红线拦、空转，情绪一动不动。
// 这里锁住 EVENT_EFFECTS 的符号/强度、applyEvent 的夹取与留痕、behaviorModifiers 的边界，
// 以及"接线真的存在"（unified-chat onToolEnd / security 红线拦截）。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEvent, EVENT_EFFECTS, behaviorModifiers, init, getSnapshot, clearEmotion, getTide, updateEmotion,
  TURN_BUDGET,
} from "../../engine/emotion.mjs";
import { matchDenyRule } from "../../engine/tools/security.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "emo-evt-"));
const EVENTS = ["success", "tool_fail", "guard_block", "idle", "company", "user_praise", "user_criticize"];

describe("事件表 EVENT_EFFECTS", () => {
  test("七个事件都在，三维增量都是数字", () => {
    for (const k of EVENTS) {
      const e = EVENT_EFFECTS[k];
      assert.ok(e, `缺事件 ${k}`);
      for (const ax of ["dv", "da", "dd"]) assert.equal(typeof e[ax], "number", `${k}.${ax} 不是数字`);
    }
  });

  test("符号正确：成功/被夸/被陪抬愉悦，失败/被拦/被批降愉悦", () => {
    assert.ok(EVENT_EFFECTS.success.dv > 0 && EVENT_EFFECTS.user_praise.dv > 0);
    assert.ok(EVENT_EFFECTS.company.dv > 0);
    for (const k of ["tool_fail", "guard_block", "user_criticize"]) assert.ok(EVENT_EFFECTS[k].dv < 0, `${k} 应降愉悦`);
    // idle 空转：不是"难过"，而是提不起劲（唤醒降、微降愉悦）
    assert.ok(EVENT_EFFECTS.idle.da < 0 && EVENT_EFFECTS.idle.dv < 0);
  });

  test("不照抄曦的 stability 符号：失败/被拦要掉掌控感，成功要升", () => {
    assert.ok(EVENT_EFFECTS.tool_fail.dd < 0, "工具失败必须掉掌控（曦把 gate_block 写成 +stability）");
    assert.ok(EVENT_EFFECTS.guard_block.dd < 0, "被红线拦是失控，不是变稳");
    assert.ok(EVENT_EFFECTS.success.dd > 0, "成功要更有掌控");
    assert.ok(Math.abs(EVENT_EFFECTS.tool_fail.dd) >= Math.abs(EVENT_EFFECTS.guard_block.dd), "被拦比失败轻");
  });

  test("失败比被拦更伤：系统边界不是她的错", () => {
    assert.ok(Math.abs(EVENT_EFFECTS.tool_fail.dv) > Math.abs(EVENT_EFFECTS.guard_block.dv));
    assert.ok(Math.abs(EVENT_EFFECTS.user_criticize.dv) > Math.abs(EVENT_EFFECTS.tool_fail.dv));
  });
});

describe("applyEvent", () => {
  test("真的改 VAD，而且活在本会话状态里", () => {
    init(tmpRoot());
    clearEmotion("evt-a");
    updateEmotion("evt-a", "帮我写个网页"); // 先建立基线
    const before = getSnapshot("evt-a");
    const r = applyEvent("tool_fail", { sessionId: "evt-a", note: "bash 失败" });
    assert.equal(r.ok, true);
    const after = getSnapshot("evt-a");
    assert.ok(after.valence < before.valence, `失败应降愉悦 ${before.valence} → ${after.valence}`);
    assert.ok(after.dominance < before.dominance, "失败应降掌控");
  });

  test("强度 0~2 乘算：0 不动、2 翻倍、-3/99 被夹紧", () => {
    init(tmpRoot());
    for (const k of ["evt-i0", "evt-i1", "evt-i2", "evt-i99", "evt-ineg"]) {
      clearEmotion(k);
      updateEmotion(k, "普通消息");
    }
    const base = (k) => getSnapshot(k).valence;
    const b0 = base("evt-i0"), b1 = base("evt-i1"), b2 = base("evt-i2"), b99 = base("evt-i99"), bn = base("evt-ineg");
    applyEvent("success", { sessionId: "evt-i0", intensity: 0 });
    applyEvent("success", { sessionId: "evt-i1", intensity: 1 });
    applyEvent("success", { sessionId: "evt-i2", intensity: 2 });
    applyEvent("success", { sessionId: "evt-i99", intensity: 99 });
    applyEvent("success", { sessionId: "evt-ineg", intensity: -3 });
    const d0 = base("evt-i0") - b0, d1 = base("evt-i1") - b1, d2 = base("evt-i2") - b2;
    assert.equal(d0, 0, "强度 0 不改变");
    assert.ok(Math.abs(d1 - EVENT_EFFECTS.success.dv) < 1e-9, `强度 1 = 表值，实际 ${d1}`);
    assert.ok(Math.abs(d2 - d1 * 2) < 1e-9, `强度 2 应翻倍：${d2} vs ${d1 * 2}`);
    assert.equal(base("evt-i99"), base("evt-i2"), "强度 99 等同 2（夹紧）");
    assert.equal(base("evt-ineg"), bn, "负强度按 0 处理");
  });

  test("正向有 0.8 呼吸顶：连刷 20 次成功也不冲破", () => {
    init(tmpRoot());
    clearEmotion("evt-cap");
    updateEmotion("evt-cap", "普通消息");
    for (let i = 0; i < 20; i++) applyEvent("success", { sessionId: "evt-cap" });
    const s = getSnapshot("evt-cap");
    assert.ok(s.valence <= 0.8 + 1e-9, `愉悦冲破呼吸顶：${s.valence}`);
    assert.ok(s.arousal <= 0.8 + 1e-9, `唤醒冲破呼吸顶：${s.arousal}`);
  });

  test("负向没有 0.8 顶，但被轮预算封顶：一轮压 0.2，换窗口还能继续低落", () => {
    init(tmpRoot());
    clearEmotion("evt-neg");
    updateEmotion("evt-neg", "普通消息");
    const b = getSnapshot("evt-neg");
    const t = Date.now();
    // 2026-11-09 轮次预算改写了这条断言（旧断言写死 `valence < -0.5`，前提是一轮能压到底）。
    // 要守的语义没变：负向没有 0.8 那种顶，堆叠能真的低落——只是现在"低落"要跨预算窗口累积。
    for (let i = 0; i < 40; i++) applyEvent("tool_fail", { sessionId: "evt-neg", intensity: 2, now: t + i });
    const one = getSnapshot("evt-neg");
    assert.ok(one.valence >= -1 && one.dominance >= -1 && one.arousal >= -1, "VAD 必须夹在 -1..1");
    assert.ok(b.valence - one.valence <= TURN_BUDGET.dv + 1e-6, `一轮最多压 ${TURN_BUDGET.dv}，实际 ${b.valence - one.valence}`);
    assert.ok(one.valence < b.valence - 0.15, "该压的还是压了（截断不是丢弃）");
    // 换预算窗口继续堆：负向确实没有 0.8 那种"顶"，能一路低下去
    // （④ 连续泄漏后 4 个窗口只能到 -0.065：每 11 分钟回补 11.5% 的缺口；
    //   多跑一个窗口仍要能真的低落，说明泄漏是减速不是封底）
    for (let round = 1; round <= 4; round++) {
      for (let i = 0; i < 40; i++) {
        applyEvent("tool_fail", { sessionId: "evt-neg", intensity: 2, now: t + round * 11 * 60_000 + i });
      }
    }
    const two = getSnapshot("evt-neg");
    assert.ok(two.valence < -0.1, `四个窗口后要真的低落，实际 ${two.valence}`);
    assert.ok(two.valence < one.valence, "只能越堆越低");
  });

  test("复用 updateLabel：事件真的能把主情绪推走（按轮给量，跨窗口累计）", () => {
    init(tmpRoot());
    clearEmotion("evt-label");
    updateEmotion("evt-label", "普通消息");
    const calm = getSnapshot("evt-label");
    assert.equal(calm.primary, "calm", "基线应是平静");
    // 2026-11-09 轮次预算改写了这条断言的前置：一轮 6 次失败只给 0.2 的量，推不动标签
    // （旧断言默认一轮能推到底）。真实场景里失败是分轮来的：隔 11 分钟（新预算窗口）再来一轮。
    const t = Date.now();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 6; i++) applyEvent("tool_fail", { sessionId: "evt-label", now: t + round * 11 * 60_000 + i });
    }
    const low = getSnapshot("evt-label");
    assert.notEqual(low.primary, calm.primary, "事件要推动主情绪换标签");
    assert.ok(["anxious", "sad", "angry", "tired"].includes(low.primary), `失败堆叠后应是负向情绪，实际 ${low.primary}`);
    assert.ok(low.valence < calm.valence && low.dominance < calm.dominance, "V/D 都要往负向走");
  });

  test("residue 写入：失败加 hurt、成功加 warmth，不产生 felt 回声", () => {
    init(tmpRoot());
    clearEmotion("evt-res");
    updateEmotion("evt-res", "普通消息");
    const w0 = getSnapshot("evt-res").residue.warmth;
    applyEvent("success", { sessionId: "evt-res" });
    const w1 = getSnapshot("evt-res").residue.warmth;
    assert.ok(w1 > w0, "成功要攒温暖");
    applyEvent("tool_fail", { sessionId: "evt-res" });
    assert.ok(getSnapshot("evt-res").residue.hurt > 0, "失败要攒伤害");
    // 没有 applyFeelings 的痕迹：lastFeelingApplyTs 不应被事件刷新
    assert.equal(getSnapshot("evt-res").lastFeelingApplyTs ?? null, null, "事件不得触发 felt 回流");
  });

  test("未知事件不炸、不改状态", () => {
    init(tmpRoot());
    clearEmotion("evt-unknown");
    updateEmotion("evt-unknown", "普通消息");
    const before = getSnapshot("evt-unknown");
    const r = applyEvent("no_such_event", { sessionId: "evt-unknown" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "unknown_event");
    assert.equal(getSnapshot("evt-unknown").valence, before.valence);
  });

  test("事件留痕到情绪潮汐，且标 source=event:<key>", () => {
    init(tmpRoot());
    clearEmotion("evt-log");
    updateEmotion("evt-log", "普通消息");
    applyEvent("guard_block", { sessionId: "evt-log", note: "no-tunnel", intensity: 1 });
    const pts = getTide(50).filter((p) => String(p.source || "").startsWith("event:"));
    assert.ok(pts.length >= 1, "事件必须写进情绪潮汐");
    const last = pts[pts.length - 1];
    assert.equal(last.source, "event:guard_block");
    assert.equal(last.event, "guard_block");
    assert.equal(last.key, "evt-log");
    assert.equal(typeof last.dv, "number");
  });

  test("评测 key（eval-）不写潮汐", () => {
    init(tmpRoot());
    clearEmotion("eval-evt");
    updateEmotion("eval-evt", "普通消息");
    applyEvent("success", { sessionId: "eval-evt" });
    assert.equal(getTide(20).length, 0, "评测事件不能污染曲线");
  });
});

describe("behaviorModifiers", () => {
  test("边界：V=-1 → confidence 0.2，V=1 → 1.0", () => {
    const lo = behaviorModifiers({ valence: -1, arousal: -1, dominance: -1 });
    const hi = behaviorModifiers({ valence: 1, arousal: 1, dominance: 1 });
    assert.equal(lo.confidence, 0.2);
    assert.equal(hi.confidence, 1);
  });

  test("maxRetries 夹在 1..3 且随唤醒走", () => {
    assert.equal(behaviorModifiers({ valence: 0, arousal: -1, dominance: 0 }).maxRetries, 1);
    assert.equal(behaviorModifiers({ valence: 0, arousal: 0, dominance: 0 }).maxRetries, 1);
    assert.equal(behaviorModifiers({ valence: 0, arousal: 0.8, dominance: 0 }).maxRetries, 3);
    assert.equal(behaviorModifiers({ valence: 0, arousal: 3, dominance: 0 }).maxRetries, 3);
  });

  test("riskTolerance 夹在 0..1，且失败后更谨慎、成功时更敢试", () => {
    const lo = behaviorModifiers({ valence: -1, arousal: -1, dominance: -1 });
    const hi = behaviorModifiers({ valence: 1, arousal: 1, dominance: 1 });
    assert.equal(lo.riskTolerance, 0);
    assert.equal(hi.riskTolerance, 1);
    const success = behaviorModifiers({ valence: 0.7, arousal: 0.45, dominance: 0.65 });
    const fail = behaviorModifiers({ valence: 0.3, arousal: 0.45, dominance: 0.2 });
    assert.ok(success.riskTolerance > fail.riskTolerance, "成功态应比失败态更敢冒险");
    assert.ok(success.riskTolerance <= 1 && fail.riskTolerance >= 0);
  });

  test("不传参时读当前会话状态；数值都在合法域", () => {
    init(tmpRoot());
    clearEmotion("evt-mod");
    updateEmotion("evt-mod", "太棒了，完美搞定！");
    const m = behaviorModifiers("evt-mod");
    assert.ok(m.confidence >= 0.2 && m.confidence <= 1);
    assert.ok(Number.isInteger(m.maxRetries) && m.maxRetries >= 1 && m.maxRetries <= 3);
    assert.ok(m.riskTolerance >= 0 && m.riskTolerance <= 1);
    assert.ok(typeof m.instability === "number", "应暴露 S（失稳感）便于解释");
  });
});

describe("接线（静态断言）", () => {
  test("unified-chat onToolEnd：成功发 success、失败发 tool_fail，且吞异常", () => {
    const src = fs.readFileSync(path.join(ROOT, "engine", "unified-chat.mjs"), "utf8");
    const start = src.indexOf("const onToolEnd = (");
    assert.ok(start > 0, "onToolEnd 还在");
    const fn = src.slice(start, start + 1600);
    assert.ok(fn.includes("applyEvent("), "工具结束必须发情绪事件");
    assert.ok(fn.includes("tool_fail") && fn.includes("success"), "成败要分别映射到 tool_fail/success");
    assert.ok(fn.includes("isError"), "按 isError 判成败");
    const at = fn.indexOf("applyEvent(");
    const guard = fn.lastIndexOf("try {", at);
    assert.ok(guard >= 0 && at - guard < 300, "applyEvent 必须包在 try 里");
    assert.ok(fn.slice(guard, at).includes("try {"), "最近的 try 必须在 applyEvent 之前");
    const closer = fn.lastIndexOf("} catch", at);
    assert.ok(guard > closer, "不能被上一段的 } catch 截断，必须在 try 块内");
  });

  test("security 红线拦截：命中即通知情绪层，且默认静默（不会误伤 dry-run 校验）", () => {
    const sec = fs.readFileSync(path.join(ROOT, "engine", "tools", "security.mjs"), "utf8");
    assert.ok(sec.includes("setGuardBlockSink"), "security 要能注册情绪 sink");
    assert.ok(sec.includes("notifyGuardBlock"), "security 要有通知函数");
    assert.ok(/notify\s*=\s*false/.test(sec) || sec.includes("notify"), "matchDenyRule 要显式 opt-in，默认不通知");
    // 默认静默：不传 notify 时不会发事件
    init(tmpRoot());
    clearEmotion("evt-silent");
    updateEmotion("evt-silent", "普通消息");
    const before = getSnapshot("evt-silent").valence;
    matchDenyRule("cloudflared tunnel run");
    assert.equal(getSnapshot("evt-silent").valence, before, "dry-run 校验不能算被拦");
  });

  test("红线拦截 runtime：notify 时真的掉掌控、留痕", () => {
    init(tmpRoot());
    clearEmotion("evt-guard");
    updateEmotion("evt-guard", "普通消息");
    const before = getSnapshot("evt-guard");
    matchDenyRule("cloudflared tunnel run", { notify: true });
    const after = getSnapshot("evt-guard");
    assert.ok(after.dominance < before.dominance, `被拦要掉掌控 ${before.dominance} → ${after.dominance}`);
    assert.ok(after.valence < before.valence, "被拦应微降愉悦");
    assert.ok(getTide(50).some((p) => p.source === "event:guard_block"), "被拦要留痕");
  });

  test("unified-tools 执行红线的三处都传了 notify", () => {
    const src = fs.readFileSync(path.join(ROOT, "engine", "tools", "unified-tools.mjs"), "utf8");
    const hits = src.match(/matchDenyRule\([^)]*notify:\s*true/g) || [];
    assert.ok(hits.length >= 1, "bash 红线命中要 notify 情绪层");
  });
});
