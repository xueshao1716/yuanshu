// withClaim：认领失败要拦住；干完/失败都要释放（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimTask, listClaims } from "../../engine/claim-board.mjs";

// 复刻 server 里的 withClaim（保持行为一致；server 版本依赖 WS_ROOT，不便直接单测）
async function withClaim({ wsRoot, task, agent = "小语", scope = [] }, fn) {
  const name = String(task || "未命名任务").slice(0, 100);
  const c = claimTask({ wsRoot, task: name, agent, scope });
  if (!c.ok) return { text: `这件事现在不能接：${c.error}`, isError: true };
  let r;
  try { r = await fn() } catch (e) {
    try { releaseClaimSafe({ wsRoot, id: c.claim.id, done: false }) } catch {}
    throw e;
  }
  releaseClaimSafe({ wsRoot, id: c.claim.id, done: !r?.isError });
  return r;
}
import { releaseClaim as releaseClaimSafe } from "../../engine/claim-board.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "claimwrap-"));

test("正常干活：结束后板上不再有 active", async () => {
  const root = ws();
  const r = await withClaim({ wsRoot: root, task: "写测试" }, async () => ({ text: "ok" }));
  assert.equal(r.text, "ok");
  const active = listClaims(root).filter((c) => c.state === "active");
  assert.equal(active.length, 0);
});

test("冲突直接拒绝，不进 fn", async () => {
  const root = ws();
  claimTask({ wsRoot: root, task: "同一件事", agent: "别人" });
  let ran = false;
  const r = await withClaim({ wsRoot: root, task: "同一件事" }, async () => { ran = true; return { text: "x" } });
  assert.equal(r.isError, true);
  assert.match(r.text, /不能接/);
  assert.equal(ran, false, "被拒绝时不该执行");
});

test("fn 失败：释放记 abandoned，板子不留残留", async () => {
  const root = ws();
  await assert.rejects(() => withClaim({ wsRoot: root, task: "会炸的活" }, async () => { throw new Error("boom") }));
  const all = listClaims(root, { includeClosed: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].state, "abandoned");
});

test("返回 isError：记 abandoned 而不是 done", async () => {
  const root = ws();
  await withClaim({ wsRoot: root, task: "失败任务" }, async () => ({ text: "nope", isError: true }));
  const all = listClaims(root, { includeClosed: true });
  assert.equal(all[0].state, "abandoned");
});
