// 元枢沙箱升级 → 人工确认卡：登记、推事件、前端 settle、超时与推送失败都 fail-closed。
import test from "node:test";
import assert from "node:assert/strict";
import * as registry from "../../engine/tools/confirm-registry.mjs";
import { createSandboxAskFactory } from "../../engine/sandbox-ask.mjs";
import { gateSandboxCall } from "../../engine/yuanshu-sandbox.mjs";

const makeWriter = () => { const events = []; return { events, push: (type, data) => events.push({ type, data }) }; };

test("无租约：登记 sandbox 确认并推 confirm 事件，前端批准后放行一次", async () => {
  const writer = makeWriter();
  const ask = createSandboxAskFactory({ registry })({ writer, sessionId: "s-ok", taskId: "t1" });
  const p = ask("write", { path: "/etc/x" }, "越出工作区");
  assert.equal(writer.events.length, 1);
  const ev = writer.events[0];
  assert.equal(ev.type, "confirm");
  assert.equal(ev.data.sessionId, "s-ok");
  assert.equal(ev.data.toolName, "write");
  const item = registry.list().find((x) => x.id === ev.data.id);
  assert.equal(item.src, "sandbox");
  assert.deepEqual(registry.settle("s-ok", ev.data.id, true), { ok: true, outcome: "allowed-once" });
  assert.equal(await p, "allowed-once");
});

test("前端拒绝 → rejected", async () => {
  const writer = makeWriter();
  const p = createSandboxAskFactory({ registry })({ writer, sessionId: "s-no" })("bash", {}, "危险命令");
  registry.settle("s-no", writer.events[0].data.id, false);
  assert.equal(await p, "rejected");
});

test("无人应答超时 → cancelled，闸门拒绝", async () => {
  const writer = makeWriter();
  const ask = createSandboxAskFactory({ registry, timeoutMs: 20 })({ writer, sessionId: "s-timeout" });
  const outcome = await ask("write", {}, "x");
  assert.equal(outcome, "cancelled");
  assert.equal(registry.hasPending("s-timeout"), false);
});

test("确认卡推不出去 → 立即拒绝，不空等超时", async () => {
  const writer = { push() { throw new Error("stream closed"); } };
  const started = Date.now();
  const outcome = await createSandboxAskFactory({ registry })({ writer, sessionId: "s-dead" })("write", {}, "x");
  assert.equal(outcome, "rejected");
  assert.ok(Date.now() - started < 1000);
  assert.equal(registry.hasPending("s-dead"), false);
});

test("维护租约期间直接放行，不登记不推卡；租约查询带会话/任务/运行", async () => {
  const writer = makeWriter();
  const seen = [];
  const ask = createSandboxAskFactory({ registry, hasLease: (q) => { seen.push(q); return true; } })({ writer, sessionId: "s-lease", taskId: "t9" });
  assert.equal(await ask("write", { runId: "r7" }, "x"), "allowed-once");
  assert.equal(writer.events.length, 0);
  assert.deepEqual(seen[0], { sessionId: "s-lease", taskId: "t9", runId: "r7" });
});

test("接到 gateSandboxCall：read-only 写文件要人批，拒绝则不执行", async () => {
  const writer = makeWriter();
  const ask = createSandboxAskFactory({ registry })({ writer, sessionId: "s-gate" });
  const pending = gateSandboxCall({ mode: "read-only", name: "write", args: { path: "a.txt" }, wsRoot: process.cwd(), ask });
  await new Promise((r) => setImmediate(r));
  assert.equal(writer.events[0]?.type, "confirm");
  registry.settle("s-gate", writer.events[0].data.id, false);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
});

test("缺 registry 直接报错，不静默放行", () => {
  assert.throws(() => createSandboxAskFactory({}), /registry required/);
});
