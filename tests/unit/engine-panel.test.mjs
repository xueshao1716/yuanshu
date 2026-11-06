// 引擎页下半：底盘/插件/能力必须是活的，不能只是展览卡
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_PLUGIN_PREFIXES,
  isCorePlugin,
  pluginFromBody,
  decorateEngineStatus,
} from "../../engine/engine-panel.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const engineSource = () => ["pages/Engine.tsx", "components/engine/EnginePairPanel.tsx", "components/engine/EngineGatewayPanels.tsx", "components/engine/EngineTools.tsx", "components/engine/EngineRunDiagnostics.tsx"].map(file => readFileSync(join(ROOT, "frontend", "src", file), "utf8")).join('\n');

test("核心底盘插件不能当普通插件卸", () => {
  assert.ok(CORE_PLUGIN_PREFIXES.length >= 4);
  assert.equal(isCorePlugin("model-adapter:http"), true);
  assert.equal(isCorePlugin("yuanshu:prompt:time"), true);
  assert.equal(isCorePlugin("echo-demo"), false);
});

test("网页只能挂预置插件，不能传 mount 函数", () => {
  const def = pluginFromBody({ preset: "echo", name: "回声" });
  assert.equal(typeof def.mount, "function");
  assert.match(def.id, /echo/);
  assert.throws(() => pluginFromBody({ id: "x", mount: "hack" }), /预置/);
});

test("status 必须带旁路说明、能力清单、插件是否核心", () => {
  const out = decorateEngineStatus(
    { components: { toolRegistry: { tools: ["bash"] } }, plugins: [{ id: "model-adapter:http", name: "适配器" }] },
    { gatewayReady: true, codeReady: true },
  );
  assert.equal(out.role, "sidecar");
  assert.match(String(out.note), /主聊天|旁路/);
  assert.ok(Array.isArray(out.capabilities) && out.capabilities.some((c) => c.id === "pair" && c.have));
  assert.ok(out.capabilities.some((c) => c.id === "hot-swap" && !c.have));
  assert.equal(out.plugins[0].core, true);
});

test("引擎页下半必须探活、挂预置插件、画活能力、接代码模式", () => {
  const src = engineSource();
  const server = readFileSync(join(ROOT, "server.mjs"), "utf8");
  assert.ok(src.includes("decorateEngineStatus") || server.includes("decorateEngineStatus"), "status 要带上面板装饰");
  assert.ok(src.includes("preset") && src.includes("registerPlugin"), "插件必须能挂预置，不能只卸");
  assert.ok(src.includes("status.capabilities") || src.includes("data.capabilities") || src.includes("capabilities"), "能力清单走接口");
  assert.ok(!src.includes("const CAPABILITIES"), "不得再写死能力展览卡");
  assert.ok(src.includes("TerminalPanel") || src.includes("CodeApi"), "代码模式要回到引擎页");
  assert.ok(src.includes("旁路") || src.includes("sidecar"), "底盘要写明不是主聊天");
});

test("文字按钮必须横向：btn-tool 不能锁死 28px 方块，引擎页中文钮用 btn-ghost", () => {
  const uno = readFileSync(join(ROOT, "frontend", "uno.config.ts"), "utf8");
  const src = engineSource();
  const term = readFileSync(join(ROOT, "frontend", "src", "components", "panels", "TerminalPanel.tsx"), "utf8");
  const m = uno.match(/'btn-tool':\s*'([^']+)'/);
  assert.ok(m, "要有 btn-tool 快捷类");
  assert.ok(!/(^|[\s'])w-7([\s']|$)/.test(m[1]), "btn-tool 不得写死 w-7，中文会竖排");
  assert.ok(!/(^|[\s'])p-0([\s']|$)/.test(m[1]), "btn-tool 不得 p-0，文字没左右内边距");
  assert.ok(m[1].includes("whitespace-nowrap") && m[1].includes("w-auto"), "文字必须 nowrap 横向撑开");
  assert.ok(!/btn-tool[^>]*>[\s\n]*探活/.test(src), "探活不能再用图标钮");
  assert.ok(src.includes("btn-ghost") && src.includes("挂回声预置"), "预置按钮用次级文字钮");
  assert.ok(term.includes("whitespace-nowrap"), "代码模式 示例/清空输出必须横向");
});

test("引擎页展示统一运行健康和阶段状态", () => {
  const src = engineSource();
  assert.ok(src.includes("RunApi.overview()"));
  assert.ok(src.includes("当前无活动任务"));
  assert.ok(src.includes("RunTimeline"));
});
