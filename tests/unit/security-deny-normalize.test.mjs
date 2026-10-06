import { test } from "node:test";
import assert from "node:assert/strict";
import { matchDenyRule, normalizeToolPath, denyCheckSegments } from "../../engine/tools/security.mjs";
import { policyDecide } from "../../engine/dsh-keys.mjs";

test("只读搜索不触发红线（真机误伤样本）", () => {
  for (const cmd of [
    'grep -rn "token" /d/pi-web/tests/e2e/*.mjs 2>/dev/null | grep -iE "url|goto|env" | head -5',
    'grep -n "CONFIG = \\|CONFIG\\.token\\|token:" /d/pi-web/server.mjs | head -10; echo "---"',
    'grep -n "share\\|tunnel\\|cloudflared" server.mjs | head',
    'ps -ef | grep -iE "share|cloudflared" | grep -v grep',
    "git grep -n cloudflared -- engine",
    "rg -n api_key engine 2>&1 | head",
  ]) assert.equal(matchDenyRule(cmd), null, cmd);
});

test("真正的红线照拦", () => {
  const cases = [
    ["echo $API_KEY > key.txt", "no-secrets-write"],
    ["printenv | grep TOKEN > env.txt", "no-secrets-write"],
    ["grep -rn api_key . > keys.txt", "no-secrets-write"],
    ["cat x | grep -e token -n > out.txt", "no-secrets-write"],
    ["cloudflared tunnel run", "no-tunnel"],
    ["ls; cloudflared tunnel run x", "no-tunnel"],
    ["grep token ~/.cloudflared/config.yml", "no-tunnel"],
    ["ssh -R 80:localhost:8787 x", "no-tunnel-ssh"],
    ["node server.mjs", "no-second-server"],
    ["git push --force origin main", "no-force-git"],
  ];
  for (const [cmd, id] of cases) assert.equal(matchDenyRule(cmd)?.id, id, cmd);
});

test("语句切分尊重引号", () => {
  assert.deepEqual(denyCheckSegments('echo "a; b" && ls'), ['echo "a; b"', "ls"]);
});

test("策略引擎与红线同口径：grep 搜索词不算操作", () => {
  assert.equal(policyDecide("bash", { command: 'grep -n "cloudflared" server.mjs' }).decision, "allow");
});

test("git-bash 路径归一", () => {
  assert.equal(normalizeToolPath("/d/pi-workspace/a.md", { platform: "win32" }), "D:/pi-workspace/a.md");
  assert.equal(normalizeToolPath("/c", { platform: "win32" }), "C:/");
  assert.equal(normalizeToolPath("/mnt/e/x", { platform: "win32" }), "E:/x");
  assert.match(normalizeToolPath("/tmp/x.txt", { platform: "win32", tmp: "T:/tmp" }), /^T:[\\/]tmp[\\/]x\.txt$/);
  assert.equal(normalizeToolPath("/docs/a", { platform: "win32" }), "/docs/a");
  assert.equal(normalizeToolPath("a.md", { platform: "win32" }), "a.md");
  assert.equal(normalizeToolPath("/d/x", { platform: "linux" }), "/d/x");
});
