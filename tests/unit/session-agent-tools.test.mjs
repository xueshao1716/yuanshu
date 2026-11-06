import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 2026-11-06：pi 工具初始化器已抽到 tool-inits.mjs，断言需要覆盖两处
const source = fs.readFileSync(new URL("../../engine/session/manager.mjs", import.meta.url), "utf8")
  + "\n" + fs.readFileSync(new URL("../../engine/session/tool-inits.mjs", import.meta.url), "utf8");
const unifiedSource = fs.readFileSync(new URL("../../engine/tools/unified-tools.mjs", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../../server.mjs", import.meta.url), "utf8");

test("Pi 会话 agent 注入技能工具并把自定义工具传给最终会话", () => {
  assert.match(source, /execActivateSkill/, "会话层必须接入真实技能执行器");
  assert.match(source, /name:\s*[\"']activate_skill[\"']/, "会话层必须注册 activate_skill");
  assert.match(source, /tools:\s*allowedTools,\s*\n\s*customTools,\s*\n\s*\}\);\s*\n\s*return created\.session/s, "最终 AgentSession 必须收到 customTools");
  assert.match(source, /FIRST_TURN_EXTRA[^\n]*activate_skill/, "首轮工具白名单必须包含 activate_skill");
  assert.doesNotMatch(source, /customTools\.push\(_THINK_TOOL\)/, "OpenAI think schema 不能直接塞进 Pi SDK");
});

test("统一引擎兼容 activate_skill 的 name 与旧 skill 参数", () => {
  assert.match(unifiedSource, /activateSkill\(args\?\.name\s*\|\|\s*args\?\.skill\)/);
});

test("PPT 请求必须注入直接执行与真实交付约束", () => {
  assert.match(serverSource, /PPT 任务执行约束/);
  assert.match(serverSource, /activate_skill/);
  assert.match(serverSource, /📎 交付/);
});
