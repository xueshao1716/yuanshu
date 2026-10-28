// 一次性审批凭据：单次消费/过期/动作与载荷绑定（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { issueToken, consumeToken, listTokens, pruneTokens, payloadDigest, readTokens } from "../../engine/approval-token.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "token-"));

test("发放 → 消费成功；同一凭据不能再用", () => {
  const root = ws();
  const { ok, token } = issueToken({ wsRoot: root, action: "merge_patch", payload: { branch: "auto/x", sha: "abc" } });
  assert.equal(ok, true);
  assert.ok(token.length > 20);

  const first = consumeToken({ wsRoot: root, token, action: "merge_patch", payload: { branch: "auto/x", sha: "abc" } });
  assert.equal(first.ok, true);

  const again = consumeToken({ wsRoot: root, token, action: "merge_patch", payload: { branch: "auto/x", sha: "abc" } });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "used");
});

test("凭据只对当初那份内容有效（sha 变了就拒）", () => {
  const root = ws();
  const { token } = issueToken({ wsRoot: root, action: "merge_patch", payload: { branch: "auto/x", sha: "aaa" } });
  const r = consumeToken({ wsRoot: root, token, action: "merge_patch", payload: { branch: "auto/x", sha: "bbb" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "payload_mismatch");
  assert.match(r.error, /和当初批准的不一致/);
  // 拒绝后凭据不该被消耗掉（还能用正确载荷）
  const good = consumeToken({ wsRoot: root, token, action: "merge_patch", payload: { branch: "auto/x", sha: "aaa" } });
  assert.equal(good.ok, true);
});

test("动作不匹配拒；过期拒", () => {
  const root = ws();
  const a = issueToken({ wsRoot: root, action: "merge_patch", payload: { sha: "1" } });
  const wrong = consumeToken({ wsRoot: root, token: a.token, action: "delete_repo", payload: { sha: "1" } });
  assert.equal(wrong.reason, "action_mismatch");

  const b = issueToken({ wsRoot: root, action: "x", payload: {}, now: 1000, ttlMs: 1000 });
  const late = consumeToken({ wsRoot: root, token: b.token, action: "x", payload: {}, now: 5000 });
  assert.equal(late.reason, "expired");
  assert.match(late.error, /重新确认/);
});

test("落盘只存哈希，不存明文", () => {
  const root = ws();
  const { token } = issueToken({ wsRoot: root, action: "a", payload: { k: 1 } });
  const file = path.join(root, "记忆", "运行时", "审批凭据.json");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(token), "文件里不该出现明文 token");
  assert.ok(text.includes("tokenHash"));
  assert.equal(readTokens(root).items.length, 1);
});

test("载荷哈希与 key 顺序无关", () => {
  assert.equal(payloadDigest({ a: 1, b: 2 }), payloadDigest({ b: 2, a: 1 }));
  assert.notEqual(payloadDigest({ a: 1 }), payloadDigest({ a: 2 }));
});

test("清理：过期未用与用过很久的都清掉", () => {
  const root = ws();
  issueToken({ wsRoot: root, action: "old", payload: {}, now: 0, ttlMs: 1000 });
  const used = issueToken({ wsRoot: root, action: "used", payload: {}, now: 0, ttlMs: 999999 });
  consumeToken({ wsRoot: root, token: used.token, action: "used", payload: {}, now: 1000 });
  const r = pruneTokens({ wsRoot: root, now: 30 * 86400_000 });
  assert.ok(r.removed >= 2);
  assert.equal(listTokens(root).length, 0);
});

test("onlyValid 只列还能用的", () => {
  const root = ws();
  issueToken({ wsRoot: root, action: "a", payload: {}, now: 0, ttlMs: 100 });
  const b = issueToken({ wsRoot: root, action: "b", payload: {}, now: 0, ttlMs: 999999 });
  const valid = listTokens(root, { onlyValid: true, now: 2000 });
  assert.deepEqual(valid.map((x) => x.action), ["b"]);
  assert.ok(b.token);
});
