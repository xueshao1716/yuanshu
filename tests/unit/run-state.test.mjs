// 运行态轻查询（/api/runs/:id/state）：客户端刷新后先问"完没完、从哪接"，
// 不该为了这个问题把整条事件流读一遍。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunApi } from "../../engine/run-api.mjs";

function make({ run = null, lastSeq = 7, withLastSeq = true } = {}) {
  const calls = [];
  const touched = { readAfter: 0 };
  const manager = {
    get: () => run,
    readAfter: () => { touched.readAfter++; return [{ seq: 99 }]; },
  };
  if (withLastSeq) manager.lastSeq = () => lastSeq;
  const api = createRunApi({ manager, json: (res, code, body) => calls.push({ code, body }), readContext: null, readDeliveries: null });
  return { api, calls, touched };
}

test("state：跑着的轮次 → done=false，带上 lastSeq 供客户端从该处接流", () => {
  const { api, calls, touched } = make({ run: { id: "r1", sessionId: "s1", status: "running", phase: "执行工具", updatedAt: new Date().toISOString() } });
  api.state({}, "r1");
  assert.equal(calls[0].code, 200);
  const b = calls[0].body;
  assert.equal(b.done, false);
  assert.equal(b.status, "running");
  assert.equal(b.lastSeq, 7);
  assert.equal(b.sessionId, "s1");
  assert.ok(b.idleMs >= 0 && b.idleMs < 5000, `idleMs 应该很小：${b.idleMs}`);
  assert.equal(touched.readAfter, 0, "轻查询不能读事件流，否则刷新恢复又变成 O(全部事件)");
});

test("state：已结束的轮次 → done=true（客户端直接渲染历史，不必开 SSE）", () => {
  for (const status of ["completed", "failed", "stopped", "interrupted"]) {
    const { api, calls } = make({ run: { id: "r1", status } });
    api.state({}, "r1");
    assert.equal(calls[0].body.done, true, `${status} 应视为已结束`);
  }
});

test("state：不存在的 run → 404；没有 lastSeq 能力时回落读事件流", () => {
  const missing = make({ run: null });
  missing.api.state({}, "nope");
  assert.equal(missing.calls[0].code, 404);

  const fallback = make({ run: { id: "r2", status: "running" }, withLastSeq: false });
  fallback.api.state({}, "r2");
  assert.equal(fallback.calls[0].body.lastSeq, 99, "没有 lastSeq 时应回落到 readAfter 的末序号");
  assert.equal(fallback.touched.readAfter, 1);
});

test("state：很久没动要看得出来（idleMs 反映最后一次状态变更）", () => {
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { api, calls } = make({ run: { id: "r3", status: "running", updatedAt: old } });
  api.state({}, "r3");
  assert.ok(calls[0].body.idleMs >= 9 * 60 * 1000, `10 分钟没动应反映出来：${calls[0].body.idleMs}`);
});
