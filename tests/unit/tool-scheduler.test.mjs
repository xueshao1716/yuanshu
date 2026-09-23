// ===== tool-scheduler.test.mjs —— 工具调度器单元测试（dsh 调度思想落地验证）=====
// 运行：node --test tests/unit/tool-scheduler.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scheduleToolCalls, ABORTED_MARKER } from "../../engine/tool-scheduler.mjs";
import { canonicalStepKey } from "../../engine/run-effects.mjs";

// 构造假工具注册表：defs 记录 parallel 标记；execute 可注入耗时
function fakeTools(defs = {}) {
  const calls = [];
  return {
    calls,
    getDef(name) { return defs[name] || null; },
    async execute(name, args) {
      const def = defs[name] || {};
      calls.push({ name, args, start: Date.now() });
      if (def.delay) await new Promise((r) => setTimeout(r, def.delay));
      calls[calls.length - 1].end = Date.now();
      return { text: `${name}:ok` };
    },
  };
}

function tc(name, args = {}, id = Math.random().toString(36).slice(2)) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

describe("tool-scheduler.mjs 工具调度器", () => {
  test('delegated tools retain host session, history, model and child event observer', async () => {
    const events = [];
    const host = { runId: 'parent', sessionId: 'session', model: { provider: 'p', id: 'm' },
      history: [{ role: 'user', content: '预算50元' }], aibodyContext: { goal: '策划' },
      onEvent: (type, data) => events.push({ type, data }) };
    let received;
    await scheduleToolCalls({ toolCalls: [tc('delegate_team', { sessionId: 'forged' })], executionContext: host,
      tools: { execute: async (_name, _args, ctx) => { received = ctx; ctx.onEvent?.('child', { id: 'real' }); return { text: 'ok' }; } } });
    assert.equal(received.sessionId, host.sessionId);
    assert.equal(received.model, host.model);
    assert.equal(received.history, host.history);
    assert.equal(received.aibodyContext, host.aibodyContext);
    assert.equal(events.length, 1);
  });
  test("结果按模型调用顺序返回（并行乱序完成也保序）", async () => {
    const tools = fakeTools({
      slow: { delay: 60 },
      fast: { delay: 5 },
      mid: { delay: 25 },
    });
    const calls = [tc("slow"), tc("fast"), tc("mid")];
    const results = await scheduleToolCalls({ toolCalls: calls, tools, maxParallel: 3 });
    assert.deepEqual(results.map((r) => r.name), ["slow", "fast", "mid"], "结果必须按模型顺序");
    assert.deepEqual(results.map((r) => r.out.text), ["slow:ok", "fast:ok", "mid:ok"]);
  });

  test("排他工具形成屏障：前后并行组不与其重叠执行", async () => {
    const tools = fakeTools({
      a: { delay: 30 },
      b: { delay: 60, parallel: false }, // 排他屏障
      c: { delay: 30 },
    });
    const calls = [tc("a"), tc("b"), tc("c")];
    const results = await scheduleToolCalls({ toolCalls: calls, tools, maxParallel: 3 });

    // 屏障校验：b 的执行区间必须完全包含于 a 结束之后、c 开始之前
    const seg = (n) => tools.calls.find((c) => c.name === n);
    assert.ok(seg("a").end <= seg("b").start, "a 必须先于 b 完成");
    assert.ok(seg("b").end <= seg("c").start, "c 必须等 b 完成后才开始");
    assert.ok(!(seg("a").start < seg("b").start && seg("a").end > seg("b").start), "a 与 b 不得重叠");
    assert.ok(!(seg("b").start < seg("c").start && seg("b").end > seg("c").start), "b 与 c 不得重叠");
    assert.deepEqual(results.map((r) => r.name), ["a", "b", "c"], "结果保序");
  });

  test("有界滚动池：并发执行数不超过 maxParallel", async () => {
    const tools = fakeTools({
      t1: { delay: 40 }, t2: { delay: 40 }, t3: { delay: 40 },
      t4: { delay: 40 }, t5: { delay: 40 },
    });
    const calls = [tc("t1"), tc("t2"), tc("t3"), tc("t4"), tc("t5")];
    let maxConcurrent = 0, active = 0;
    const origExecute = tools.execute;
    tools.execute = async (name, args) => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { text: `${name}:ok` };
    };
    await scheduleToolCalls({ toolCalls: calls, tools, maxParallel: 2 });
    assert.ok(maxConcurrent <= 2, `并发峰值 ${maxConcurrent} 应 ≤ 2`);
    assert.ok(maxConcurrent === 2, "并发峰值应达到上限 2（有界池生效）");
  });

  test("abort 不撒谎：已启动的排空，未启动的补合成错误结果", async () => {
    const tools = fakeTools({
      first: { delay: 40 },
      second: { delay: 10 },
      third: { delay: 10 },
    });
    const calls = [tc("first"), tc("second"), tc("third")];
    const signal = { aborted: false };
    // maxParallel=1（串行）：first 启动后 15ms 触发 abort → first 排空，second/third 未启动补合成
    const timer = setTimeout(() => { signal.aborted = true; }, 15);
    const results = await scheduleToolCalls({ toolCalls: calls, tools, signal, maxParallel: 1 });
    clearTimeout(timer);

    assert.equal(results.length, 3, "消息序列必须完整（3 个结果）");
    assert.equal(results[0].out.text, "first:ok", "已启动的调用应正常完成（排空）");
    assert.equal(results[1].out.text, ABORTED_MARKER, "未启动的补合成错误结果");
    assert.equal(results[2].out.text, ABORTED_MARKER);
    assert.ok(results[1].out.isError === true && results[2].out.isError === true);
    // 关键：second/third 不能被真正执行
    assert.ok(!tools.calls.some((c) => c.name === "second"), "second 不应被执行");
    assert.ok(!tools.calls.some((c) => c.name === "third"), "third 不应被执行");
  });

  test("提前 abort：一个都不执行，全部补合成结果", async () => {
    const tools = fakeTools({ a: {}, b: {} });
    const signal = { aborted: true };
    const results = await scheduleToolCalls({ toolCalls: [tc("a"), tc("b")], tools, signal });
    assert.deepEqual(results.map((r) => r.out.text), [ABORTED_MARKER, ABORTED_MARKER]);
    assert.equal(tools.calls.length, 0, "不应有任何真实执行");
  });

  test("未知工具：返回 isError 而非抛错（真实 ToolRegistry）", async () => {
    const { ToolRegistry } = await import("../../engine/tool-registry.mjs");
    const reg = new ToolRegistry();
    reg.register({ name: "known", description: "", handler: () => ({ text: "known:ok" }) });
    const results = await scheduleToolCalls({ toolCalls: [tc("known"), tc("unknown")], tools: reg });
    assert.equal(results[0].out.text, "known:ok");
    assert.equal(results[1].out.isError, true);
    assert.ok(String(results[1].out.text).includes("未知工具"), "应提示未知工具");
  });

  test("恢复阻断结果保留原始 ordinal 和 effectKey", async () => {
    const secondArgs = { path: "uncertain.txt" };
    const secondKey = canonicalStepKey("read", secondArgs, { turn: 4, index: 1 });
    const beginMeta = [];
    const effects = {
      begin(_runId, key, meta) {
        beginMeta.push({ key, ordinal: meta.ordinal });
        return { action: "blocked", reason: "uncertain" };
      },
    };
    const resumedCall = tc("read", secondArgs);
    Object.defineProperty(resumedCall, "__ordinal", { value: 1, enumerable: false });
    const results = await scheduleToolCalls({
      toolCalls: [resumedCall],
      effects,
      executionContext: { runId: "run-1", turn: 4 },
    });
    assert.equal(results[0].ordinal, 1);
    assert.equal(results[0].effectKey, secondKey);
    assert.deepEqual(beginMeta, [{ key: secondKey, ordinal: 1 }]);
  });
});
