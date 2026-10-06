import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SANDBOX_MODES,
  sandboxDeniedTag,
  canEscalate,
  toolSandboxNeed,
  pathInWorkspace,
  checkSandboxCall,
  applyEscalation,
  gateSandboxCall,
} from "../../engine/yuanshu-sandbox.mjs";
import { runYuanshuToolRound } from "../../engine/yuanshu-loop.mjs";

test("权限只升不降，read-only 是地板", () => {
  assert.deepEqual(SANDBOX_MODES, ["read-only", "workspace-write", "danger-full-access"]);
  assert.equal(canEscalate("read-only", "workspace-write"), true);
  assert.equal(canEscalate("workspace-write", "danger-full-access"), true);
  assert.equal(canEscalate("danger-full-access", "read-only"), false);
  assert.equal(canEscalate("workspace-write", "read-only"), false);
  assert.equal(canEscalate("read-only", "read-only"), false);
});

test("工具需求：读只读，写在工作区，危险 bash 要 danger", () => {
  assert.equal(toolSandboxNeed("read"), "read-only");
  assert.equal(toolSandboxNeed("write"), "workspace-write");
  assert.equal(toolSandboxNeed("bash", { command: "ls" }), "workspace-write");
  assert.equal(toolSandboxNeed("bash", { command: "rm -rf D:/pi-workspace" }), "danger-full-access");
});

test("workspace-write 路径必须落在工作区", () => {
  assert.equal(pathInWorkspace("D:/ws", "D:/ws/a.md"), true);
  assert.equal(pathInWorkspace("D:/ws", "a.md"), true);
  assert.equal(pathInWorkspace("D:/ws", "D:/other/secret.md"), false);
});

test("checkSandboxCall：read-only 拦写，拒绝词统一", () => {
  const r = checkSandboxCall({ mode: "read-only", name: "write", args: { path: "a.md" } });
  assert.equal(r.ok, false);
  assert.equal(r.escalate, true);
  assert.equal(r.to, "workspace-write");
  assert.equal(r.tag, sandboxDeniedTag("read-only"));
  assert.match(r.tag, /\[sandbox: file access denied under read-only mode\]/);
});

test("升级必须带 justification，无应答 fail-closed", async () => {
  const noJust = checkSandboxCall({
    mode: "workspace-write",
    name: "bash",
    args: { command: "rm -rf /", sandbox_permissions: "danger-full-access" },
  });
  assert.equal(noJust.ok, false);
  assert.match(String(noJust.note), /justification/);

  const gated = await gateSandboxCall({
    mode: "read-only",
    name: "write",
    args: { path: "a.md" },
  });
  assert.equal(gated.ok, false);
  assert.match(String(gated.note), /fail-closed|无应答/);
  assert.equal(applyEscalation("read-only", { to: "workspace-write", approved: false }), "read-only");
  assert.equal(applyEscalation("read-only", { to: "workspace-write", approved: true }), "workspace-write");
});

test("runYuanshuToolRound：read-only 不执行 write", async () => {
  const ran = [];
  const history = [];
  await runYuanshuToolRound({
    toolCalls: [{ id: "1", type: "function", function: { name: "write", arguments: "{\"path\":\"a.md\",\"content\":\"x\"}" } }],
    history,
    execute: async (name) => { ran.push(name); return { text: "ok" }; },
    policyDecide: () => ({ decision: "allow" }),
    jitForPath: () => [],
    sandboxMode: "read-only",
  });
  assert.equal(ran.length, 0);
  assert.match(String(history[0].content), /sandbox: file access denied under read-only mode/);
});

test("git-bash 路径归一：/d/x、/tmp/x 不再误判越界", () => {
  assert.equal(pathInWorkspace("D:/ws", "/d/ws/a.md"), process.platform === "win32");
  const ok = checkSandboxCall({ mode: "workspace-write", name: "write", args: { path: "/d/ws/x.html" }, wsRoot: "D:/ws" });
  assert.equal(ok.ok, process.platform === "win32");
});

test("read 不卡路径；write/edit 认工作区 + 系统目录双根", async () => {
  const { SYSTEM_ROOT } = await import("../../engine/yuanshu-sandbox.mjs");
  const ws = process.platform === "win32" ? "Z:/ws-none" : "/ws-none";
  assert.equal(checkSandboxCall({ mode: "workspace-write", name: "read", args: { path: "/tmp/a.txt" }, wsRoot: ws }).ok, true);
  assert.equal(checkSandboxCall({ mode: "workspace-write", name: "write", args: { path: `${SYSTEM_ROOT}/tmp/p.mjs` }, wsRoot: ws }).ok, true);
  const out = checkSandboxCall({ mode: "workspace-write", name: "edit", args: { path: "../../outside/x" }, wsRoot: ws });
  assert.equal(out.ok, false);
  assert.match(out.note, /可写范围/);
  assert.equal(checkSandboxCall({ mode: "read-only", name: "write", args: { path: "a.md" }, wsRoot: ws }).ok, false);
});
