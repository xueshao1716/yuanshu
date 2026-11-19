// 省电显示：软件渲染检测（2026-11-19，新电脑没显卡驱动时 webview 吃满 CPU）
import { test } from "node:test";
import assert from "node:assert/strict";

const fakeDoc = ({ strict, loose = true, renderer = "" }) => ({
  createElement: () => ({
    getContext: (_k, opts) => {
      if (opts?.failIfMajorPerformanceCaveat && !strict) return null;
      if (!opts && !loose) return null;
      return { getExtension: (n) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 1 } : { loseContext() {} }), getParameter: () => renderer };
    },
  }),
});
const fresh = async () => import(`../../frontend/src/lib/lite-mode.mjs?t=${Math.random()}`);

test("有性能折扣的 WebGL 拿不到、普通的拿得到 → 判为软件渲染", async () => {
  assert.equal((await fresh()).detectSoftwareRender(fakeDoc({ strict: false })), true);
});
test("渲染器名字是 SwiftShader / 基本显示适配器 → 软件渲染", async () => {
  assert.equal((await fresh()).detectSoftwareRender(fakeDoc({ strict: true, renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))" })), true);
  assert.equal((await fresh()).detectSoftwareRender(fakeDoc({ strict: true, renderer: "ANGLE (Microsoft, Microsoft Basic Render Driver)" })), true);
});
test("正常显卡 → 不开；WebGL 完全不可用 → 不误判", async () => {
  assert.equal((await fresh()).detectSoftwareRender(fakeDoc({ strict: true, renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620)" })), false);
  assert.equal((await fresh()).detectSoftwareRender(fakeDoc({ strict: false, loose: false })), false);
});
