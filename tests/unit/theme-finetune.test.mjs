// 2026-11-17 主题页「精调当前主题」：层级密度存不下来、液态玻璃主题吃掉主色与配色卡色纱、配色卡同一组列两遍
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initThemePrefs, loadThemePrefs, saveThemePrefs } from "../../engine/theme-prefs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

function withPrefs(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pi-theme-prefs-"));
  try { initThemePrefs(join(dir, "theme-prefs.json")); fn(); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("层级密度按主题分别存，服务端能存能读；只改主题时不丢", () => withPrefs(() => {
  saveThemePrefs({ theme: "liquid-glass", accent: "", densities: { "liquid-glass": 0.05, mist: 0.03 } });
  saveThemePrefs({ theme: "ink", accent: "#8b7cf6" });
  assert.deepEqual(loadThemePrefs().densities, { "liquid-glass": 0.05, mist: 0.03 });
}));

test("密度只收合法主题名与 0.02~0.08 的数，其余丢掉", () => withPrefs(() => {
  saveThemePrefs({ theme: "mist", densities: { mist: 0.5, ink: "x", "../a": 0.04, bamboo: 0.021 } });
  assert.deepEqual(loadThemePrefs().densities, { bamboo: 0.021 });
}));

test("前端：密度跟着主题走、自动同步；重置回到「默认」主色", () => {
  const apply = read("frontend", "src", "theme", "apply.ts");
  assert.match(apply, /themeDensities\(\)\[theme\]/, "applyThemeVars 要套用该主题记下的密度（切主题器换主题也生效）");
  assert.match(apply, /preferences\.densities/, "水合时要恢复服务端的密度");
  const themes = read("frontend", "src", "pages", "Themes.tsx");
  assert.match(themes, /ThemeApi\.save\(theme, accent, wallpaper, densities\)/, "保存要带上密度");
  assert.match(themes, /const handleReset = \(\) => \{[\s\S]{0,200}selectAccent\(''\)/, "重置要回到主题默认主色（空串），不是写死色值");
});

test("配色卡只列一遍：每张卡上直接给「用于创作 / 套成壁纸 / 取主色」", () => {
  const themes = read("frontend", "src", "pages", "Themes.tsx");
  assert.equal((themes.match(/COLOR_CARDS\.filter/g) || []).length, 1, "同一组配色卡不要渲染两遍");
  assert.ok(themes.includes('data-slot="color-card-studio"'), "创作配色卡单独一块，不挤在主题精调里");
  assert.ok(themes.includes("套成壁纸") && themes.includes("取主色"), "卡片上要有套壁纸/取主色");
});

test("液态玻璃主题：主按钮跟随主色，配色卡色纱不被玻璃底盖掉", () => {
  const css = read("frontend", "src", "styles.css");
  const v2 = css.slice(css.indexOf("液态玻璃主题 v2"));
  const btn = v2.match(/\.btn-primary\s*\{[^}]*\}/)?.[0] || "";
  assert.match(btn, /var\(--pi-accent\)/, "主按钮不能写死蓝色");
  assert.doesNotMatch(btn, /rgba\(64, 116, 230/, "主按钮不能写死蓝色");
  assert.match(v2, /body\.has-color-card \.col-sidebar[^{]*\{[^}]*var\(--pi-card-shell-left\)/, "左栏玻璃底上要叠回配色卡色纱");
  assert.match(v2, /body\.has-color-card \.col-right[^{]*\{[^}]*var\(--pi-card-shell-right\)/, "右栏同理");
});
