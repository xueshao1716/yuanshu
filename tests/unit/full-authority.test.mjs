// 全权模式 / 大胆模式（2026-11-24）：限时自动批准、到点收回、账本截断、确认卡改 note、大胆提示词开关
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as raw from "../../engine/tools/confirm-registry.mjs";
import {
  configureFullAuthority, wrapRegistry, fullAuthorityState, fullAuthorityLedger, enableFullAuthority,
  disableFullAuthority, rewriteAutoConfirm, boldMode, setBoldMode, BOLD_PROMPT,
} from "../../engine/full-authority.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "full-auth-"));
let t = 1_700_000_000_000;
configureFullAuthority({ wsRoot: () => dir, clock: () => t });
const reg = wrapRegistry(raw);

test("关着时走原注册表进 pending", () => {
  assert.equal(fullAuthorityState().on, false);
  const r = reg.register("s1", { toolName: "bash", reason: "x" });
  assert.ok(!r.auto);
  assert.ok(raw.hasPending("s1"));
  raw.cancelAll("s1");
});

test("开启后立即放行、记账、确认卡改成 note", async () => {
  assert.throws(() => enableFullAuthority(3));
  const st = enableFullAuthority(1, "测试");
  assert.equal(st.on, true);
  const r = reg.register("s2", { toolName: "persona-governance", reason: "改人格" });
  assert.equal(r.auto, true);
  assert.equal(await r.promise, "allowed-once");
  assert.equal(raw.hasPending("s2"), false);
  assert.equal(fullAuthorityLedger(5)[0].toolName, "persona-governance");
  const [type, data] = rewriteAutoConfirm("confirm", { id: r.id, toolName: "persona-governance", sessionId: "s2" });
  assert.equal(type, "note");
  assert.match(data.text, /全权模式已自动放行/);
  assert.deepEqual(rewriteAutoConfirm("confirm", { id: "other" }), ["confirm", { id: "other" }]);
});

test("到点自动收回、手动收回", () => {
  enableFullAuthority(1);
  t += 3600_000 + 1;
  assert.equal(fullAuthorityState().on, false);
  enableFullAuthority(2);
  assert.equal(disableFullAuthority().on, false);
  assert.ok(!reg.register("s3", { toolName: "bash" }).auto);
  raw.cancelAll("s3");
});

test("账本只留 500 行", () => {
  enableFullAuthority(8);
  for (let i = 0; i < 520; i++) reg.register("s4", { toolName: `t${i}` });
  const lines = fs.readFileSync(path.join(dir, "记忆", "运行时", "全权放行.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 500);
  assert.equal(fullAuthorityLedger(1)[0].toolName, "t519");
  disableFullAuthority();
});

test("大胆模式开关与提示词", () => {
  assert.equal(boldMode(), false);
  assert.equal(setBoldMode(true), true);
  assert.equal(boldMode(), true);
  assert.equal(setBoldMode(false), false);
  assert.match(BOLD_PROMPT, /密钥/);
});

test("接入点：server 用包装后的注册表，SSE 与总线都过滤，提示词段已注册", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  assert.match(server, /const confirmRegistry = wrapRegistry\(rawConfirmRegistry\)/);
  assert.match(server, /"\/api\/authority\/full"/);
  assert.match(fs.readFileSync(path.join(ROOT, "engine/sse.mjs"), "utf8"), /rewriteAutoConfirm\(event, data\)/);
  assert.match(fs.readFileSync(path.join(ROOT, "engine/session/bus.mjs"), "utf8"), /rewriteAutoConfirm\(type, data\)/);
  assert.match(fs.readFileSync(path.join(ROOT, "engine/unified-chat.mjs"), "utf8"), /yuanshu:prompt:bold/);
});
