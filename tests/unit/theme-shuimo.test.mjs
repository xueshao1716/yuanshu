// 水墨 / 竹影：色板、生成器、apply 必须同源挂上 data-theme
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "src");
const read = (...parts) => readFileSync(join(SRC, ...parts), "utf8");

test("水墨竹影进入色板、种子、主题页，apply 写入 data-theme", () => {
  const palettes = read("theme", "palettes.ts");
  const generate = read("theme", "generate.mjs");
  const apply = read("theme", "apply.ts");
  const themes = read("pages", "Themes.tsx");
  const switcher = read("components", "ThemeSwitcher.tsx");
  for (const id of ["shuimo", "bamboo"]) {
    assert.ok(palettes.includes(`id: '${id}'`), `色板缺少 ${id}`);
    assert.ok(generate.includes(`${id}:`), `生成器缺少 ${id} 种子`);
    assert.ok(apply.includes(`'${id}'`), `applyThemeVars 必须给 ${id} 写 data-theme`);
  }
  assert.ok(themes.includes("THEME_CATALOG"), "主题页必须读统一目录");
  assert.ok(palettes.includes("name: '水墨'"), "色板必须有水墨");
  assert.ok(palettes.includes("name: '竹影'"), "色板必须有竹影");
  assert.ok(switcher.includes("import { applyTheme, currentTheme } from '../theme/apply'"), "ThemeSwitcher 必须走 apply 同源，避免 data-theme 列表分叉");
});

test("拟态木进入色板、种子、主题页，apply 写 data-theme，翠绿作主色", () => {
  const palettes = read("theme", "palettes.ts");
  const generate = read("theme", "generate.mjs");
  const apply = read("theme", "apply.ts");
  const themes = read("pages", "Themes.tsx");
  const css = read("styles.css");
  assert.ok(palettes.includes("id: 'wood'"), "色板缺少 wood");
  assert.ok(palettes.includes("name: '拟木'"), "切换器名称必须是拟木");
  assert.ok(generate.includes("wood:"), "生成器缺少 wood 种子");
  // 2026-09-16：主色从 #0B8A54 压深到 #007D4B——同一个绿在枫木底（#ddc9a8）上只有 2.72，
  // 而主色到处被当文字用（芯片/链接/状态）。仍然是翠绿，只是够读了。
  assert.ok(/accent: '#0[07]7[dD]4[bB]'/.test(generate), "拟木主色必须还是翠绿（现为 #007d4b，压深过）");
  assert.ok(apply.includes("'wood'"), "applyThemeVars 必须给 wood 写 data-theme");
  assert.ok(themes.includes("THEME_CATALOG"), "主题页必须读统一目录");
  assert.ok(css.includes('[data-theme="wood"]'), "styles 必须有 wood 区块");
  assert.ok(css.includes('[data-theme="wood"] body'), "拟木必须有木纹底，不能只换色");
  assert.ok(css.includes("拟木·木纹"), "拟木手写区必须有木纹特化，不能只靠生成 token");
});

test("牛皮纸必须有纤维纸面特化，阴影是完整 box-shadow 不是纯色", () => {
  const generate = read("theme", "generate.mjs");
  const css = read("styles.css");
  const palettes = read("theme", "palettes.ts");
  const kraftBlock = generate.split("kraft:")[1].split("sepia:")[0];
  assert.ok(kraftBlock.includes("'--pi-shadow-sm': '0 "), "牛皮纸 --pi-shadow-sm 必须是完整投影，不能只写 rgba");
  assert.ok(css.includes("牛皮纸·纤维"), "牛皮纸手写区必须有纤维纸面，不能只靠暖棕换色");
  assert.ok(css.includes('[data-theme="kraft"] body'), "牛皮纸必须铺纤维底");
  assert.ok(palettes.includes("纤维纸面"), "主题目录描述必须点出纤维纸面");
});
