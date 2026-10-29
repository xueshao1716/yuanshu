// 回归：只读模式那段不能再用未定义的 cwd（2026-10-29）
//
// 现场：微信里她为了读一篇公众号文章，bash/run_code 反复失败，报「工具执行失败: cwd is not defined」，
// 于是换着法子重试 9 次——不是她笨，是工具坏了。
// 根因：2026-10-28 加只读模式时写成 readOnlyOn(cwd())，而那个作用域里变量叫 getCwd。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("D:/pi-web/engine/tools/unified-tools.mjs", "utf8");

test("只读检查用的是注入的 getCwd()，不是不存在的 cwd()", () => {
  assert.ok(src.includes("readOnlyOn(getCwd())"), "必须调用 getCwd()");
  assert.ok(!/[^a-zA-Z_.]cwd\(\)/.test(src.replace(/getCwd\(\)/g, "")), "不能再出现裸 cwd()");
});

test("执行器里确实注入了 getCwd", () => {
  assert.ok(/const getCwd = deps\.cwd \|\|/.test(src));
});
