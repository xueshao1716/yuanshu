// 事件驱动情绪的防饱和三闸（2026-11-09 补）
// 缺口：工具成功 +0.07V，从暖基线 0.55 到 0.8 呼吸顶只要 ~4 次成功；而 decayToBaseline
// 只在 lastTalk 超 1 小时后才动——一个连续工作的下午事件只加不减，必然贴顶，顶部没有分辨率
// （曦系统"连续 40 多条 calm/0.39"就是这个病）。这里锁四件事：
//   ① 轮次事件预算：同一轮累计注入 |dV|≤0.2 / |dA|≤0.15 / |dD|≤0.2，超出按比例截断；
//   ② 同事件边际递减：10 分钟内同一 eventKey 第 n 次按 1/n^0.7 生效（先递减，再截断）；
//   ③ 预算只作用于 applyEvent，用户话语（关键词 VAD）路径不受影响；
//   ④ 会话内连续泄漏 + 顶部软压缩：与空闲无关，按真实经过时间把 VAD 往基线拉；
//      0.7→0.8 顶部区正向增量线性趋 0。三闸只把"1 轮贴顶"拖成"2–3 轮"，④ 才是解决长时间贴顶的那条。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyEvent, init, clearEmotion, getSnapshot, getTide, updateEmotion, EVENT_EFFECTS,
  TURN_BUDGET, TURN_BUDGET_WINDOW_MS, EVENT_DECAY_WINDOW_MS, EVENT_DECAY_EXPONENT,
  LEAK_RATE_PER_MIN, LEAK_AROUSAL_MULT, LEAK_DOMINANCE_MULT, LEAK_MAX_ELAPSED_MS,
  LEAK_MIN_ELAPSED_MS, SOFT_TOP_START, SOFT_TOP_CAP,
} from "../../engine/emotion.mjs";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "emo-sat-"));
const decayOf = (n) => 1 / Math.pow(n, EVENT_DECAY_EXPONENT);
// 固定"下午 3 点"：躲开 ① 时间节律（6–11 点 +0.02V/+0.03A），让曲线可复现
const T0 = new Date(2026, 10, 9, 15, 0, 0).getTime();
const MIN = 60_000;
// 这条消息只吃 user_frustrated 的 −0.15V（clamp），不带任何任务词
const NEG_MSG = "难过 伤心 生气 愤怒 崩溃 烦 无语 垃圾 失败";

describe("① 轮次事件预算（只作用于 applyEvent）", () => {
  test("一轮内 10 次成功：|ΔV| ≤ 0.2，budgetClamped 有记录，且是截断不是丢弃", () => {
    init(tmpRoot());
    clearEmotion("bud-10");
    updateEmotion("bud-10", "普通消息");
    const before = getSnapshot("bud-10");
    const t = Date.now();
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(applyEvent("success", { sessionId: "bud-10", intensity: 1, now: t + i }));
    }
    const after = getSnapshot("bud-10");
    const dV = after.valence - before.valence;
    const dA = after.arousal - before.arousal;
    const dD = after.dominance - before.dominance;

    assert.ok(dV > 0, `事件还是要往上走，实际 ${dV}`);
    assert.ok(dV <= TURN_BUDGET.dv + 1e-6, `|ΔV| 必须 ≤ ${TURN_BUDGET.dv}，实际 ${dV}`);
    assert.ok(dV > 0.19, `截断不是丢弃：额度要用完，实际 ${dV}`);
    assert.ok(dA <= TURN_BUDGET.da + 1e-6 && dA > 0.1, `|ΔA| 封在 ${TURN_BUDGET.da}，实际 ${dA}`);
    assert.ok(dD <= TURN_BUDGET.dd + 1e-6 && dD > 0.14, `|ΔD| 封在 ${TURN_BUDGET.dd}，实际 ${dD}`);
    assert.equal(TURN_BUDGET.dv, 0.2);
    assert.equal(TURN_BUDGET.da, 0.15);
    assert.equal(TURN_BUDGET.dd, 0.2);

    const clamped = results.filter((r) => r.budgetClamped === true);
    assert.ok(clamped.length >= 1, "必须有 budgetClamped:true 的记录");
    assert.ok(results.every((r) => r.ok === true), "被截断也要 ok:true，不是报错");
    // 原始（递减后、截断前）与实际增量都记了，且原始 ≥ 实际
    for (const r of clamped) {
      assert.equal(typeof r.requestedDelta.dv, "number");
      assert.equal(typeof r.delta.dv, "number");
      assert.ok(Math.abs(r.requestedDelta.dv) >= Math.abs(r.delta.dv) - 1e-9, "原始增量不可能小于实际");
    }
    const partial = clamped.find((r) => Math.abs(r.delta.dv) > 0 && Math.abs(r.delta.dv) < Math.abs(r.requestedDelta.dv) - 1e-9);
    assert.ok(partial, "被截断的事件要按比例留一部分，而不是直接归零");
    assert.equal(results[0].budgetClamped, false, "第一次事件离预算还远，不该被标记成截断");

    // 潮汐里也留痕：原始/实际增量都能查
    const tide = getTide(200).filter((p) => p.source === "event:success");
    assert.ok(tide.some((p) => p.budgetClamped === true), "潮汐里要能查到 budgetClamped");
    const hit = tide.find((p) => p.budgetClamped === true);
    assert.equal(typeof hit.reqV, "number", "潮汐要记原始增量 reqV");
    assert.equal(typeof hit.dv, "number", "潮汐要记实际增量 dv");
  });

  test("不同 sessionId 各一本预算账，互不挤占", () => {
    init(tmpRoot());
    for (const k of ["bud-a", "bud-b"]) { clearEmotion(k); updateEmotion(k, "普通消息"); }
    const t = Date.now();
    const b = getSnapshot("bud-b");
    for (let i = 0; i < 10; i++) applyEvent("success", { sessionId: "bud-a", intensity: 1, now: t + i });
    const r = applyEvent("success", { sessionId: "bud-b", intensity: 1, now: t + 100 });
    assert.equal(r.budgetClamped, false, "另一个会话的额度不能被前一个会话吃掉");
    assert.ok(Math.abs(getSnapshot("bud-b").valence - b.valence - 0.1) < 1e-9, "单次成功仍是满额 +0.1");
  });

  test("换轮重新给额度：同一 10 分钟内两轮各自 0.2", () => {
    init(tmpRoot());
    clearEmotion("bud-turn");
    updateEmotion("bud-turn", "第一轮", { turnId: "turn-1" });
    const t = Date.now();
    let b = getSnapshot("bud-turn");
    for (let i = 0; i < 10; i++) applyEvent("success", { sessionId: "bud-turn", intensity: 1, now: t + i });
    let a = getSnapshot("bud-turn");
    const d1 = a.valence - b.valence;
    assert.ok(d1 > 0.19 && d1 <= TURN_BUDGET.dv + 1e-6, `第一轮额度 0.2，实际 ${d1}`);

    // 新一轮（turnId 变）→ 预算清零。第二轮换负向事件（-0.14V/次，V 轴先撞顶），
    // 既避开同事件递减的叠加干扰，也避开正向 0.8 呼吸顶
    updateEmotion("bud-turn", "第二轮", { turnId: "turn-2" });
    b = getSnapshot("bud-turn");
    const rs = [];
    for (let i = 0; i < 10; i++) rs.push(applyEvent("user_criticize", { sessionId: "bud-turn", intensity: 1, now: t + 2000 + i }));
    a = getSnapshot("bud-turn");
    // ④ 连续泄漏之后，快照差值会多混进这 2 秒的回落（0.5e-4 量级），额度账要按"注入量"算才准
    const d2 = -(rs.reduce((s, r) => s + r.delta.dv, 0));
    assert.ok(d2 > 0.19 && d2 <= TURN_BUDGET.dv + 1e-9, `换轮后应重新拿到 0.2 额度，实际 ${d2}`);
    assert.ok(b.valence - a.valence > 0.19, `第二轮快照也得真的掉下去，实际 ${b.valence - a.valence}`);
  });

  test("预算窗口常量是 10 分钟；超窗口后额度自动回满", () => {
    assert.equal(TURN_BUDGET_WINDOW_MS, 10 * 60_000);
    init(tmpRoot());
    clearEmotion("bud-window");
    updateEmotion("bud-window", "普通消息");
    const t = Date.now();
    for (let i = 0; i < 10; i++) applyEvent("success", { sessionId: "bud-window", intensity: 1, now: t + i });
    const spent = getSnapshot("bud-window").valence;
    const r = applyEvent("success", { sessionId: "bud-window", intensity: 1, now: t + 11 * 60_000 });
    assert.equal(r.budgetClamped, false, "11 分钟后额度应回满");
    assert.ok(getSnapshot("bud-window").valence > spent, "回满后必须能继续注入");
  });
});

describe("② 同事件边际递减（先递减，再截断）", () => {
  test("10 分钟内同一事件第 n 次：1 / 0.62 / 0.46", () => {
    init(tmpRoot());
    clearEmotion("dec-3");
    updateEmotion("dec-3", "普通消息");
    const t = Date.now();
    const d = [];
    let prev = getSnapshot("dec-3").valence;
    // 用 company（0.07V）而不是 success（0.10V）：三次叠加仍在 0.2 预算内，落差不被预算掩盖
    for (let i = 0; i < 3; i++) {
      applyEvent("company", { sessionId: "dec-3", now: t + i });
      const v = getSnapshot("dec-3").valence;
      d.push(v - prev);
      prev = v;
    }
    assert.ok(d.every((x) => x > 0), `三次都要有增量（递减不是关掉）：${d.join(" / ")}`);
    const r2 = d[1] / d[0];
    const r3 = d[2] / d[0];
    assert.ok(Math.abs(r2 - decayOf(2)) < 1e-6, `第 2 次应是 ${decayOf(2).toFixed(4)}，实际 ${r2.toFixed(4)}`);
    assert.ok(Math.abs(r3 - decayOf(3)) < 1e-6, `第 3 次应是 ${decayOf(3).toFixed(4)}，实际 ${r3.toFixed(4)}`);
    // 题目口径的约数：第 2 次 ~62%，第 3 次 ~46%（1/3^0.7 = 0.4634）
    assert.ok(r2 > 0.55 && r2 < 0.7, `第 2 次应约 62%，实际 ${(r2 * 100).toFixed(1)}%`);
    assert.ok(r3 > 0.4 && r3 < 0.55, `第 3 次应约 46%，实际 ${(r3 * 100).toFixed(1)}%`);
  });

  test("隔 11 分钟再触发恢复满强度（时间滑窗，不是永久惩罚）", () => {
    assert.equal(EVENT_DECAY_WINDOW_MS, 10 * 60_000);
    init(tmpRoot());
    clearEmotion("dec-window");
    updateEmotion("dec-window", "普通消息");
    const t = Date.now();
    // ④ 连续泄漏会在 11 分钟里把状态拉回一点，快照差值不再等于单次注入量；
    // 这条测的是"同事件递减的窗口"，所以按 applyEvent 实际注入量断言（那才是额度契约）。
    const r0 = applyEvent("company", { sessionId: "dec-window", now: t });
    const r1 = applyEvent("company", { sessionId: "dec-window", now: t + 11 * 60_000 });
    assert.ok(Math.abs(r1.delta.dv - r0.delta.dv) < 1e-9, `11 分钟后应恢复满强度：${r0.delta.dv} vs ${r1.delta.dv}`);
    assert.ok(Math.abs(r1.delta.dv - 0.07) < 1e-9, "满强度 = 表值 0.07");
  });

  test("截断用的是递减后的量，且三维按同一比例（保方向）", () => {
    init(tmpRoot());
    clearEmotion("dec-order");
    updateEmotion("dec-order", "普通消息");
    const t = Date.now();
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(applyEvent("success", { sessionId: "dec-order", intensity: 1, now: t + i }));

    // 递减先作用在"本次想注入多少"上：requestedDelta = 表值 × 1/n^0.7
    for (let i = 0; i < 4; i++) {
      const want = 0.1 * decayOf(i + 1);
      assert.ok(Math.abs(Math.abs(rs[i].requestedDelta.dv) - want) < 1e-4, `第 ${i + 1} 次原始增量应是 ${want.toFixed(5)}，实际 ${rs[i].requestedDelta.dv}`);
      assert.equal(+rs[i].decay.toFixed(4), +decayOf(i + 1).toFixed(4));
    }
    // 第 3 次把额度用满 → 按比例截断
    const c = rs[2];
    assert.equal(c.budgetClamped, true, "第 3 次应撞上 0.2 预算");
    const k = c.delta.dv / c.requestedDelta.dv;
    assert.ok(k > 0 && k < 1, `应是按比例截断，实际比例 ${k}`);
    assert.ok(Math.abs(c.delta.da / c.requestedDelta.da - k) < 1e-3, "A 轴要同一比例");
    assert.ok(Math.abs(c.delta.dd / c.requestedDelta.dd - k) < 1e-3, "D 轴要同一比例");

    // 额度用尽后再来同事件：0 增量但 ok:true（不报错、不写脏状态）
    const z = applyEvent("success", { sessionId: "dec-order", intensity: 1, now: t + 10 });
    assert.equal(z.ok, true);
    assert.equal(z.budgetClamped, true);
    assert.equal(z.delta.dv, 0);
  });
});

describe("③ 预算只作用于事件，不影响用户话语路径", () => {
  test("关键词 VAD 照旧：连续三轮重词能涨过 0.2（不被事件预算截）", () => {
    init(tmpRoot());
    clearEmotion("talk-path");
    updateEmotion("talk-path", "普通消息");
    const b = getSnapshot("talk-path");
    for (let i = 0; i < 3; i++) updateEmotion("talk-path", "太棒了，完美搞定，厉害，谢谢！");
    const d = getSnapshot("talk-path").valence - b.valence;
    assert.ok(d > TURN_BUDGET.dv + 0.01, `话语路径不该受事件预算限制，实际只涨了 ${d.toFixed(3)}`);
  });
});

// ══ ④ 会话内连续泄漏 + 顶部软压缩（2026-11-09 第四条防饱和）══════════════
// 前三闸只在"注入侧"限流，加是即时的、减要等空闲 1 小时：连续工作一下午照样贴顶。
// ④ 补的是"减"这一侧：只要时间在走（有更新/读取），VAD 就按真实经过时间往基线漏一点。
describe("④ 会话内连续泄漏（与空闲无关，按真实经过时间）", () => {
  test("常量：0.011/min（60 分钟剩 ~51.5%）、A 1.5 倍、D 0.7 倍、单次封顶 60 分钟", () => {
    assert.equal(LEAK_RATE_PER_MIN, 0.011);
    assert.equal(LEAK_AROUSAL_MULT, 1.5);
    assert.equal(LEAK_DOMINANCE_MULT, 0.7);
    assert.equal(LEAK_MAX_ELAPSED_MS, 60 * 60_000);
    assert.equal(SOFT_TOP_START, 0.7);
    assert.equal(SOFT_TOP_CAP, 0.8);
    // 注释里写的"1 小时约 52% / 唤醒更快 / 掌控更黏"必须和常量对得上
    const stay = (rate, mult = 1) => Math.pow(1 - rate * mult, 60);
    assert.ok(Math.abs(stay(LEAK_RATE_PER_MIN) - 0.515) < 0.001, `V 60 分钟应剩 51.5%，实际 ${stay(LEAK_RATE_PER_MIN)}`);
    assert.ok(stay(LEAK_RATE_PER_MIN, LEAK_AROUSAL_MULT) < 0.38, `A 应回落更快，实际剩 ${stay(LEAK_RATE_PER_MIN, LEAK_AROUSAL_MULT)}`);
    assert.ok(stay(LEAK_RATE_PER_MIN, LEAK_DOMINANCE_MULT) > 0.62, `D 应更黏，实际剩 ${stay(LEAK_RATE_PER_MIN, LEAK_DOMINANCE_MULT)}`);
  });

  test("连续工作一下午（每 3 分钟一轮、每轮 5 次成功 intensity 0.7，8 轮）：不再恒 0.800", () => {
    init(tmpRoot());
    const sid = "sat-afternoon";
    clearEmotion(sid);
    updateEmotion(sid, "继续", { turnId: "init", now: T0 });
    const curve = [];
    for (let r = 0; r < 8; r++) {
      const rt = T0 + r * 3 * MIN;
      // 每轮开轮换 turnId：真实用法里 updateEmotion 记 turnId → 轮预算重开，上一步实测就是这么跑的
      updateEmotion(sid, "继续", { turnId: `r${r}`, now: rt });
      for (let j = 0; j < 5; j++) {
        applyEvent("success", { sessionId: sid, intensity: 0.7, now: rt + (j + 1) * 1000 });
      }
      curve.push(+getSnapshot(sid, { now: rt + 5000 }).valence.toFixed(4));
    }
    // 曲线自证：第 1 轮还是老样貌（0.2 预算给完 ≈ 0.695），之后不再一路顶到 0.800
    assert.ok(curve[0] > 0.68 && curve[0] < 0.71, `第 1 轮应 ≈0.695（与实测口径对齐），实际 ${curve[0]}`);
    assert.ok(curve.every((v) => v < SOFT_TOP_CAP - 1e-9), `任何一轮都不能贴 0.800：${curve.join(" → ")}`);
    const late = curve.slice(3); // 第 4–8 轮
    assert.ok(late.every((v) => v < SOFT_TOP_CAP - 1e-9), `第 4–8 轮不能贴顶：${late.join(" → ")}`);
    assert.ok(new Set(late.map((v) => v.toFixed(3))).size >= 3, `第 4–8 轮要有波动（不是一块 0.800），实际 ${late.join(" → ")}`);
    assert.ok(late[1] - late[0] > 0.001, `第 5 轮还得在走（渐近，不是冻住），实际 ${late[0]} → ${late[1]}`);
    assert.ok(curve[7] <= 0.79, `末轮不高于 0.79，实际 ${curve[7]}`);
    assert.ok(curve[7] - curve[6] < curve[1] - curve[0], "增量必须越走越小（渐近）");
  });

  test("10 分钟没有任何事件：读一次也按分钟泄漏（|V−基线| 缩 ~10.5%）", () => {
    init(tmpRoot());
    const sid = "leak-10min";
    clearEmotion(sid);
    updateEmotion(sid, "继续", { turnId: "init", now: T0 });
    applyEvent("success", { sessionId: sid, intensity: 1, now: T0 + 1000 });
    applyEvent("success", { sessionId: sid, intensity: 1, now: T0 + 2000 });
    const s0 = getSnapshot(sid, { now: T0 + 2000 });
    // 之后 10 分钟没有任何事件，只是"过了 10 分钟再读一次"
    const s10 = getSnapshot(sid, { now: T0 + 10 * MIN + 2000 });
    const baseV = 0.55 + (s0.residue.warmth - s0.residue.hurt) * 0.1; // 泄漏目标 = 暖基线 + 残留偏移
    const expectV = baseV + (s0.valence - baseV) * Math.pow(1 - LEAK_RATE_PER_MIN, 10);
    assert.ok(Math.abs(s10.valence - expectV) < 1e-9, `10 分钟应剩 ${expectV}，实际 ${s10.valence}`);
    const shrinkV = (s0.valence - s10.valence) / (s0.valence - baseV);
    assert.ok(shrinkV > 0.09 && shrinkV < 0.12, `|ΔV| 应缩 ~10.5%，实际 ${(shrinkV * 100).toFixed(1)}%`);
    assert.ok(s0.valence - s10.valence > 0.008, `缩的绝对值要看得见，实际 ${s0.valence - s10.valence}`);
    // A 用 1.5 倍速率：同样的 10 分钟，唤醒回落更快
    const baseA = 0.35;
    const shrinkA = (s0.arousal - s10.arousal) / (s0.arousal - baseA);
    assert.ok(shrinkA > shrinkV * 1.3, `A 应比 V 回落快：${(shrinkA * 100).toFixed(1)}% vs ${(shrinkV * 100).toFixed(1)}%`);
    // 小于 1 秒的抖动不结算（同一批工具调用里连发十几次，不能把时钟打散）
    assert.equal(LEAK_MIN_ELAPSED_MS, 1000);
  });

  test("指数无记忆：一次 60 分钟 = 十次 6 分钟（怎么切分读，落点一样）", () => {
    init(tmpRoot());
    const setup = (sid) => {
      clearEmotion(sid);
      updateEmotion(sid, "继续", { turnId: "init", now: T0 });
      applyEvent("success", { sessionId: sid, intensity: 1, now: T0 + 1000 });
      applyEvent("success", { sessionId: sid, intensity: 1, now: T0 + 2000 });
    };
    setup("leak-whole"); setup("leak-split");
    const v0 = getSnapshot("leak-whole", { now: T0 + 2000 }).valence;
    for (let i = 1; i <= 10; i++) getSnapshot("leak-split", { now: T0 + i * 6 * MIN + 2000 });
    const snapWhole = getSnapshot("leak-whole", { now: T0 + 60 * MIN + 2000 });
    const split = getSnapshot("leak-split", { now: T0 + 60 * MIN + 2000 }).valence;
    assert.ok(Math.abs(snapWhole.valence - split) < 1e-9, `切分结算必须等价：${snapWhole.valence} vs ${split}`);
    const baseV = 0.55 + (snapWhole.residue.warmth - snapWhole.residue.hurt) * 0.1;
    const remain = (snapWhole.valence - baseV) / (v0 - baseV);
    assert.ok(remain > 0.5 && remain < 0.53, `1 小时后应剩 ~51.5% 的差值，实际 ${(remain * 100).toFixed(1)}%`);
  });

  test("单次结算封顶 60 分钟：离线 1 小时和 3 小时的读数完全一样（离线归 decayToBaseline）", () => {
    init(tmpRoot());
    const setup = (sid) => {
      clearEmotion(sid);
      updateEmotion(sid, "继续", { turnId: "init", now: T0 });
      applyEvent("success", { sessionId: sid, intensity: 1, now: T0 + 1000 });
      applyEvent("success", { sessionId: sid, intensity: 1, now: T0 + 2000 });
    };
    setup("cap-1h"); setup("cap-3h");
    const v0 = getSnapshot("cap-1h", { now: T0 + 2000 }).valence;
    const h1 = getSnapshot("cap-1h", { now: T0 + 60 * MIN + 2000 }).valence;
    const h3 = getSnapshot("cap-3h", { now: T0 + 180 * MIN + 2000 }).valence;
    assert.ok(Math.abs(h1 - h3) < 1e-12, `3 小时不能比 1 小时多抹一次：${h1} vs ${h3}`);
    assert.ok(h1 < v0 - 0.005, "该漏的还是要漏");
    assert.ok(h1 > 0.55, "但单次不能把 V 直接抹回基线");
  });

  test("空闲 >1h 的 decayToBaseline 没被动：5 小时正好回基线（两者叠加、分工不变）", () => {
    init(tmpRoot());
    const sid = "idle-5h";
    clearEmotion(sid);
    updateEmotion(sid, "继续", { turnId: "init", now: T0 });
    applyEvent("success", { sessionId: sid, intensity: 2, now: T0 + 1000 });
    assert.ok(getSnapshot(sid, { now: T0 + 1000 }).valence > 0.6, "先被抬起来");
    updateEmotion(sid, "继续", { turnId: "back", now: T0 + 5 * 60 * MIN });
    const s = getSnapshot(sid, { now: T0 + 5 * 60 * MIN });
    const baseV = 0.55 + (s.residue.warmth - s.residue.hurt) * 0.1;
    assert.ok(Math.abs(s.valence - baseV) < 1e-9, `5 小时（>4h 窗口）应正好落回基线 ${baseV}，实际 ${s.valence}`);
  });
});

describe("④b 顶部软压缩", () => {
  test("V=0.78 时再给 +0.1 的正向事件，实际增量 < 0.01", () => {
    init(tmpRoot());
    const sid = "soft-top";
    clearEmotion(sid);
    updateEmotion(sid, "继续", { turnId: "init", now: T0 });
    // 真实路径把 V 推到 0.78 附近：4 轮 × 5 次成功（intensity 0.7）
    for (let r = 0; r < 4; r++) {
      const rt = T0 + r * 3 * MIN;
      updateEmotion(sid, "继续", { turnId: `r${r}`, now: rt });
      for (let j = 0; j < 5; j++) applyEvent("success", { sessionId: sid, intensity: 0.7, now: rt + (j + 1) * 1000 });
    }
    const last = T0 + 3 * 3 * MIN + 5000;
    const before = getSnapshot(sid, { now: last });
    assert.ok(before.valence > 0.77 && before.valence < 0.79, `先到 0.78 附近，实际 ${before.valence}`);
    updateEmotion(sid, "继续", { turnId: "final", now: last }); // 换轮：预算重开，隔离"额度不够"的干扰
    const r = applyEvent("success", { sessionId: sid, intensity: 1, now: last }); // 名义 +0.1
    const after = getSnapshot(sid, { now: last });
    const dV = after.valence - before.valence;
    // 系数就是题面那条线性式，且此时确实在压缩区
    const want = (SOFT_TOP_CAP - before.valence) / (SOFT_TOP_CAP - SOFT_TOP_START);
    assert.ok(Math.abs(r.softCap.v - want) < 1e-3, `系数应是 (0.8−V)/0.1 = ${want.toFixed(3)}，实际 ${r.softCap.v}`);
    assert.ok(r.softCap.v > 0.1 && r.softCap.v < 0.3, `0.78 处系数应 ~0.21，实际 ${r.softCap.v}`);
    assert.ok(dV > 0, "压到再小也要还活着（不是关掉）");
    assert.ok(dV < 0.01, `实际增量必须 <0.01，实际 ${dV}`);
    assert.ok(dV < 0.3 * 0.1 * r.decay, `压缩后应远小于未压缩的 ${(0.1 * r.decay).toFixed(4)}，实际 ${dV}`);
    // 留痕：潮汐里能查到这次被软压了多少
    assert.ok(getTide(300).some((p) => p.source === "event:success" && typeof p.softV === "number"), "潮汐要记 softV");
  });

  test("负向不受压缩：V≈-0.5 时 -0.1 的事件全额生效（只压正向）", () => {
    init(tmpRoot());
    const sid = "soft-neg";
    clearEmotion(sid);
    updateEmotion(sid, "继续", { turnId: "init", now: T0 });
    for (let r = 0; r < 8; r++) updateEmotion(sid, NEG_MSG, { turnId: `n${r}`, now: T0 + r * 3 * MIN });
    const last = T0 + 8 * 3 * MIN;
    updateEmotion(sid, "继续", { turnId: "final", now: last });
    const before = getSnapshot(sid, { now: last });
    assert.ok(before.valence < -0.45 && before.valence > -0.6, `先落到 -0.5 附近，实际 ${before.valence}`);
    const r = applyEvent("tool_fail", { sessionId: sid, intensity: 1, now: last });
    const after = getSnapshot(sid, { now: last });
    assert.equal(r.softCap.v, 1, "负向增量不压缩");
    assert.ok(Math.abs((after.valence - before.valence) - EVENT_EFFECTS.tool_fail.dv) < 1e-9,
      `-0.12 要全额生效，实际 ${after.valence - before.valence}`);
    // 同一次事件里 A 的正向增量（+0.05）仍会被顶部软化：负向只放过 V 这一轴
    assert.ok(r.softCap.a < 0.5, `A 轴已在高位，正向增量仍要软压，实际 ${r.softCap.a}`);
  });
});
