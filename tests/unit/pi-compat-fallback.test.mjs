import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiCompatFallback } from "../../engine/pi-compat-fallback.mjs";

test("缺少 pi SDK 时兼容层仍可建会话、落盘和提供空模型运行时", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-pi-fallback-"));
  try {
    const sdk = createPiCompatFallback({ agentDir: root });
    const sm = sdk.SessionManager.create(root, path.join(root, "sessions"));
    sm.appendSessionInfo("fallback");
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    assert.equal(fs.existsSync(sm.getSessionFile()), true);
    assert.equal(sm.getTree().length, 2);
    assert.equal((await sdk.ModelRuntime.create()).getModels().length, 0);
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root });
    await loader.reload();
    assert.ok(Array.isArray(loader.getSkills().skills));
    await assert.rejects(() => sdk.createAgentSessionServices(), /pi SDK 不可用/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
