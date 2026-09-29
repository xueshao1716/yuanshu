import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadNetworkConfig } from "../../engine/system-panel.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOKEN = fs.existsSync(path.join(ROOT, ".token"))
  ? fs.readFileSync(path.join(ROOT, ".token"), "utf8").trim()
  : "";
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const PUBLIC_FILES = [
  "engine/mcp-server.mjs",
  "scripts/visual-engine.mjs",
  "install-demo.ps1",
  "frontend/public/label.js",
  "public/label.js",
  "frontend/dist/label.js",
  "app/dist/label.js",
  "tests/quantum-theme-test.mjs",
  "tests/quantum-theme-test.py",
  "tests/unit/sanitize-filebox.test.mjs",
];

test("公开源码和发布资源不含本机访问令牌", () => {
  if (!TOKEN) return;
  for (const file of PUBLIC_FILES) assert.equal(read(file).includes(TOKEN), false, file);
});

test("没有令牌时公共客户端脚本不伪造 Authorization", () => {
  for (const file of ["frontend/public/label.js", "public/label.js", "frontend/dist/label.js", "app/dist/label.js"]) {
    const source = read(file);
    assert.equal(source.includes('REDACTED_LOCAL_TOKEN'), false, file);
    assert.equal(/Authorization\s*:\s*['"]Bearer\s+['"]\s*\+\s*localStorage\.getItem\([^)]*\)\s*\|\|/.test(source), false, file);
  }
});

test("首次生成的网络入口配置不泄露私人域名", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-network-") );
  try {
    const config = loadNetworkConfig(root);
    assert.deepEqual(config.domains, []);
    assert.equal(/myxinyu|私人域名/i.test(JSON.stringify(config)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("公共登录和移动壳配置不绑定私人域名", () => {
  const files = [
    "frontend/src/components/Login.tsx",
    "frontend/src/lib/shell-origin.ts",
    "app/src-tauri/src/lib.rs",
    "app/src-tauri/capabilities/remote-piweb.json",
    "tests/unit/android-shell.test.mjs",
  ];
  for (const file of files) assert.equal(/myxinyu/i.test(read(file)), false, file);
});

test("系统页区分连接失败、登记入口与服务端版本", () => {
  const source = read("frontend/src/pages/System.tsx");
  for (const text of ['连接失败', '已登记入口', '不会自动配置 DNS 或隧道', '服务端版本']) {
    assert.ok(source.includes(text), `缺少准确状态文案: ${text}`);
  }
  assert.ok(source.includes('!!data && !error'));
  const login = read('frontend/src/components/Login.tsx');
  assert.equal(login.includes('本地安全连接'), false);
  assert.equal(login.includes('正在建立安全连接'), false);
});
