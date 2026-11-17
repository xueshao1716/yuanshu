// 主题目录（5 个）：色板、生成器、apply 必须同源挂上 data-theme
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "src");
const read = (...parts) => readFileSync(join(SRC, ...parts), "utf8");

const KEPT = ["liquid-glass", "mist", "shuimo", "obsidian", "bridge"];
const MERGED = { kraft: "shuimo", bamboo: "shuimo", wood: "shuimo", ink: "obsidian", violet: "obsidian", sepia: "obsidian", moss: "obsidian", azure: "obsidian" };

// 2026-11-17：用户嫌主题太多，收成 5 个；被合并的主题，已选它的人自动换到对应的新主题
test("主题收成 5 个：目录只剩 液态玻璃/晨雾/水墨/曜石/舰桥，旧主题自动迁移", async () => {
  const palettes = read("theme", "palettes.ts");
  const apply = read("theme", "apply.ts");
  const themes = read("pages", "Themes.tsx");
  const switcher = read("components", "shell", "ThemeSwitcher.tsx");
  const css = read("styles.css") + read("premium.css");
  const catalog = palettes.split("export const THEME_CATALOG")[1].split("]")[0];
  assert.deepEqual([...catalog.matchAll(/id: '([a-z-]+)'/g)].map(m => m[1]).sort(), [...KEPT].sort());
  const { SEEDS, resolveThemeId } = await import("../../frontend/src/theme/generate.mjs");
  for (const id of KEPT) {
    assert.ok(SEEDS[id], `生成器缺少 ${id} 种子`);
    assert.ok(apply.includes(`'${id}'`), `applyThemeVars 必须给 ${id} 写 data-theme`);
    assert.equal(resolveThemeId(id), id);
  }
  for (const [old, to] of Object.entries(MERGED)) {
    assert.equal(SEEDS[old], undefined, `${old} 种子应已删`);
    assert.equal(resolveThemeId(old), to, `${old} 要迁到 ${to}`);
    assert.ok(!css.includes(`data-theme="${old}"`), `样式里不得残留 ${old}`);
  }
  assert.ok(/resolveThemeId\(/.test(apply), "apply 读写主题前要先迁移旧 id");
  assert.ok(themes.includes("THEME_CATALOG"), "主题页必须读统一目录");
  // 2026-11-06：ThemeSwitcher 已移入 components/shell/，相对上一层
  assert.ok(switcher.includes("import { applyTheme, currentTheme } from '../../theme/apply'"), "ThemeSwitcher 必须走 apply 同源，避免 data-theme 列表分叉");
});

test("舰桥：科幻主题进目录/种子/apply，有 HUD 特化且不破坏弹层定位", () => {
  const palettes = read("theme", "palettes.ts");
  const generate = read("theme", "generate.mjs");
  const apply = read("theme", "apply.ts");
  const css = read("styles.css");
  assert.ok(palettes.includes("id: 'bridge'") && palettes.includes("name: '舰桥'"), "色板缺少舰桥");
  assert.ok(generate.includes("bridge:"), "生成器缺少 bridge 种子");
  assert.ok(apply.includes("'bridge'"), "applyThemeVars 必须给 bridge 写 data-theme");
  assert.ok(css.includes("舰桥·HUD"), "舰桥必须有 HUD 特化区块");
  assert.ok(css.includes('[data-theme="bridge"] body'), "舰桥必须有网格底");
  // 2026-10-06：给 .panel 加 position: relative 会以更高优先级盖掉 .fixed/.absolute，对话框和下拉会掉位
  const block = css.split("舰桥·HUD")[1];
  for (const m of block.matchAll(/([^{}]+)\{[^}]*position:\s*relative/g)) {
    assert.ok(/:not\(\.absolute, \.fixed, \.sticky\)/.test(m[1]), `舰桥给 ${m[1].trim()} 加 relative 必须排除已定位弹层`);
  }
});

test("曜石：旗舰深色进目录/种子/apply/生成区块，深色 color-scheme，主按钮白字够读", async () => {
  const palettes = read("theme", "palettes.ts");
  const apply = read("theme", "apply.ts");
  const css = read("styles.css");
  assert.ok(palettes.includes("id: 'obsidian'") && palettes.includes("name: '曜石'"), "色板缺少曜石");
  assert.ok(apply.includes("'obsidian'"), "applyThemeVars 必须给 obsidian 写 data-theme");
  assert.ok(css.includes('[data-theme="obsidian"] {\n  --pi-bg: #0F1117;'), "生成区块里要有曜石的令牌");
  assert.match(css, /html\[data-theme="obsidian"\] \{ color-scheme: dark; \}/, "曜石要声明深色 color-scheme");
  const { SEEDS, generateTheme, contrast } = await import("../../frontend/src/theme/generate.mjs");
  const v = generateTheme(SEEDS.obsidian);
  // 全站很多主按钮写的是白字：曜石主色必须让白字过 4.5
  assert.ok(contrast("#ffffff", v["--pi-accent"]) >= 4.5, "曜石主色上的白字不够读");
  assert.match(css, /--pi-ease-spring: linear\(/, "要有弹簧缓动令牌");
});
