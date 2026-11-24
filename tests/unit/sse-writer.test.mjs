// ══ SSE 背压 writer 单元测试 ══
// 验证 createSseWriter：背压排队 / drain 后按序 flush / flush() 等待 / close 安全
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 从 engine/sse.mjs 提取 createSseWriter（2026-08-20 拆模块：server.mjs → engine/sse.mjs）
const serverSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "sse.mjs"),
  "utf8"
);
const fnMatch = serverSrc.match(/function createSseWriter[\s\S]*?\n}/);
if (!fnMatch) throw new Error("engine/sse.mjs 中未找到 createSseWriter");
// 2026-11-24：push 里会过一道全权模式的确认卡改写，这里给个原样返回的替身
globalThis.rewriteAutoConfirm = (t, d) => [t, d];
// ESM 里 eval 不进模块作用域 → 用 indirect eval（global scope）定义
(0, eval)(fnMatch[0] + "\nglobalThis.__createSseWriter = createSseWriter;");
const createSseWriter = globalThis.__createSseWriter;

// 造一个可编程假 res：write 返回可控制，drain 回调可手动触发
function makeFakeRes({ failAfter = Infinity, failOnce = false } = {}) {
  const written = [];
  let drainCb = null;
  let failed = false;
  const res = {
    written,
    _drain() { if (drainCb) { const cb = drainCb; drainCb = null; cb(); } },
    write(chunk) {
      written.push(chunk);
      if (failOnce && !failed && written.length === failAfter) {
        failed = true;
        return false; // 这次返回 false（缓冲满）
      }
      return true;
    },
    once(ev, cb) { if (ev === "drain") drainCb = cb; },
  };
  return res;
}

test("正常写入：事件按序写出，格式正确", () => {
  const res = makeFakeRes();
  const w = createSseWriter(res);
  w.push("delta", { text: "你好" });
  w.push("tool", { name: "read", id: "t1" });
  w.push("done", {});
  w.close();
  const all = res.written.join("");
  assert.match(all, /event: delta\ndata: \{"text":"你好"\}/);
  assert.match(all, /event: tool\ndata: \{"name":"read","id":"t1"\}/);
  assert.match(all, /event: done\ndata: \{\}/);
  assert.ok(all.indexOf("你好") < all.indexOf("t1"), "事件顺序应保持");
});

test("背压：write 返回 false 后事件排队，drain 后按序写出", () => {
  const res = makeFakeRes({ failOnce: true, failAfter: 2 });
  const w = createSseWriter(res);
  w.push("delta", { text: "a" }); // 写出
  w.push("delta", { text: "b" }); // 第2个后触发返回 false
  w.push("delta", { text: "c" }); // 排队
  w.push("delta", { text: "d" }); // 排队
  assert.equal(res.written.length, 2, "背压时后续事件应排队");
  res._drain(); // 内核清空 → drain
  assert.equal(res.written.length, 4, "drain 后剩余事件应全部写出");
  const pos = s => res.written.join("").indexOf(`"text":"${s}"`);
  assert.ok(pos("a") < pos("b") && pos("b") < pos("c") && pos("c") < pos("d"), "顺序应保持");
});

test("flush()：draining 时挂起，drain 后 resolve", async () => {
  const res = makeFakeRes({ failOnce: true, failAfter: 1 });
  const w = createSseWriter(res);
  w.push("delta", { text: "x" }); // 触发返回 false
  w.push("delta", { text: "y" }); // 排队
  let resolved = false;
  const p = w.flush().then(() => { resolved = true; });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(resolved, false, "flush 在 pending 未清空前不应 resolve");
  res._drain();
  await p;
  assert.equal(resolved, true, "drain 后 flush 应 resolve");
  assert.equal(res.written.length, 2, "全部写出");
});

test("close() 后 push 静默忽略，不抛错", () => {
  const res = makeFakeRes();
  const w = createSseWriter(res);
  w.push("done", {});
  w.close();
  assert.doesNotThrow(() => w.push("delta", { text: "x" }));
});

test("多轮背压：连续两次 drain 都能恢复", () => {
  const written = [];
  let drainCb = null;
  let budget = 1; // 每次 drain 后只允许写 1 个
  const res = {
    write(c) {
      written.push(c);
      if (budget <= 0) return false;
      budget--;
      return true;
    },
    once(ev, cb) { if (ev === "drain") drainCb = cb; },
  };
  const w = createSseWriter(res);
  for (let i = 1; i <= 5; i++) w.push("delta", { text: String(i) });
  // budget=1：第1个写出成功，第2个写入但返回 false（内核缓冲已满，数据未丢）→ draining，后续排队
  assert.equal(written.length, 2, "第2个已进入缓冲（write 返回 false 不等于丢弃）");
  // 第一轮 drain：写第3个（成功，budget→0），第4个写入但返回 false（也进缓冲）→ 又挂 drain
  budget = 1; drainCb();
  assert.equal(written.length, 4);
  // 第二轮 drain：写第5个（成功）
  budget = 1; drainCb();
  assert.equal(written.length, 5, "全部 5 个都已进入缓冲");
  // 收尾
  budget = 10; drainCb();
  assert.equal(written.length, 5, "没有重复写出");
  const pos = s => written.join("").indexOf(`"text":"${s}"`);
  assert.ok(pos("1") < pos("2") && pos("2") < pos("3") && pos("3") < pos("4") && pos("4") < pos("5"));
});
