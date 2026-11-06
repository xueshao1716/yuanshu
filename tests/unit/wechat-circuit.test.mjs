// 发送熔断：阈值 / 窗口 / 递增冷却 / 成功后不误伤（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCircuit } from "../../engine/wechat/circuit.mjs";

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, tick: (ms) => { t += ms }, set: (v) => { t = v } };
}

test("不到阈值不开闸", () => {
  const c = fakeClock();
  const circuit = createCircuit({ threshold: 3, now: c.now });
  circuit.recordFailure();
  circuit.recordFailure();
  assert.equal(circuit.isOpen(), false);
});

test("连续 3 次 → 开闸，冷却期内一直是开的", () => {
  const c = fakeClock();
  const circuit = createCircuit({ threshold: 3, openMs: 60_000, now: c.now });
  circuit.recordFailure(); circuit.recordFailure();
  const opened = circuit.recordFailure();
  assert.equal(opened, true);
  assert.equal(circuit.isOpen(), true);
  c.tick(30_000);
  assert.equal(circuit.isOpen(), true);
  c.tick(31_000);
  assert.equal(circuit.isOpen(), false, "冷却到期应自动关闭");
});

test("冷却时间按失败次数递增，但有上限", () => {
  const c = fakeClock();
  const circuit = createCircuit({ threshold: 1, openMs: 60_000, maxOpenMs: 120_000, now: c.now });
  circuit.recordFailure();
  const first = circuit.remainingMs();
  c.tick(first + 1000);
  circuit.recordFailure();
  const second = circuit.remainingMs();
  assert.ok(second >= first, "第二次应该更久");
  assert.ok(second <= 120_000, "不超过上限");
});

test("成功一次后，窗口内的失败不再累加导致误开", () => {
  const c = fakeClock();
  const circuit = createCircuit({ threshold: 3, windowMs: 60_000, now: c.now });
  circuit.recordFailure(); circuit.recordFailure();
  circuit.recordSuccess();
  circuit.recordFailure();
  assert.equal(circuit.isOpen(), false, "成功应清空计数");
});

test("窗口外的旧失败不计入", () => {
  const c = fakeClock();
  const circuit = createCircuit({ threshold: 2, windowMs: 10_000, now: c.now });
  circuit.recordFailure();
  c.tick(15_000);
  circuit.recordFailure();
  assert.equal(circuit.isOpen(), false, "第一条已滑出窗口");
});

test("snapshot 给面板用", () => {
  const c = fakeClock();
  const circuit = createCircuit({ threshold: 2, now: c.now });
  circuit.recordFailure(); circuit.recordFailure();
  const s = circuit.snapshot();
  assert.equal(s.open, true);
  assert.ok(s.remainingMs > 0);
  assert.equal(s.openCount, 1);
});
