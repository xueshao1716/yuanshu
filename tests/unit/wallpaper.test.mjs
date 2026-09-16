import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { wallpaperCssImage } from "../../frontend/src/theme/wallpaper.mjs";
import { MORANDI_CARDS, colorCardGradient } from "../../frontend/src/theme/colorcards.mjs";
import { initThemePrefs, loadThemePrefs, saveThemePrefs } from "../../engine/theme-prefs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

test("渐变壁纸不能包进 url()，否则 CSS 非法、点预设等于没设", () => {
  const g = "linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 100%)";
  assert.equal(wallpaperCssImage(g), g);
  assert.ok(!wallpaperCssImage(g).startsWith("url("));
});

test("图片 URL / data URL 才包 url()", () => {
  assert.equal(wallpaperCssImage("https://ex.com/a.png"), 'url("https://ex.com/a.png")');
  assert.ok(wallpaperCssImage("data:image/png;base64,abc").startsWith("url("));
});

test("空壁纸返回空串", () => {
  assert.equal(wallpaperCssImage(""), "");
  assert.equal(wallpaperCssImage(null), "");
});

test("主题页和布局必须用共享壁纸函数，禁止一律 url(${wallpaper})", () => {
  const themes = read("frontend", "src", "pages", "Themes.tsx");
  const layout = read("frontend", "src", "AppLayout.tsx");
  assert.ok(themes.includes("persistWallpaper"), "Themes 必须 persistWallpaper（写本地并 apply）");
  assert.ok(layout.includes("applyWallpaper"), "AppLayout 必须走共享 applyWallpaper");
  assert.ok(!themes.includes("url(${wallpaper})"), "Themes 不得把渐变包进 url()");
  assert.ok(!layout.includes("url(${w})"), "AppLayout 不得把渐变包进 url()");
});

test("壁纸仅在背景层显示，工作画布保留实底", () => {
  const css = read("frontend", "src", "styles.css");
  assert.ok(css.includes("body.has-wallpaper"), "必须有 has-wallpaper 状态");
  const canvas = css.split("body.has-wallpaper .col-canvas {")[1]?.split("}")[0] || "";
  assert.ok(canvas.includes("background: var(--pi-bg)"), "中栏画布必须保留可读的实底");
});

test("只改主题/主色时不得把已保存的壁纸写成空", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-theme-prefs-"));
  try {
    initThemePrefs(join(dir, "theme-prefs.json"));
    saveThemePrefs({ theme: "mist", accent: "#5468ff", wallpaper: "linear-gradient(90deg,#000,#111)" });
    saveThemePrefs({ theme: "ink", accent: "#8b7cf6" });
    const after = loadThemePrefs();
    assert.equal(after.theme, "ink");
    assert.equal(after.wallpaper, "linear-gradient(90deg,#000,#111)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("显式传空壁纸才清除", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-theme-prefs-"));
  try {
    initThemePrefs(join(dir, "theme-prefs.json"));
    saveThemePrefs({ theme: "mist", wallpaper: "https://ex.com/a.png" });
    saveThemePrefs({ theme: "mist", wallpaper: "" });
    assert.equal(loadThemePrefs().wallpaper, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThemeApi.save 不得把省略的 wallpaper 默认成空串写进请求体", () => {
  const api = read("frontend", "src", "api.ts");
  const block = api.split("export const ThemeApi")[1]?.split("export const ")[0] || "";
  assert.ok(block.includes("wallpaper !== undefined") || block.includes("wallpaper != null"), "未传 wallpaper 时不得写进 body");
  assert.ok(!block.includes("wallpaper: string = ''") && !block.includes('wallpaper: string = ""'), "不得默认 wallpaper 为空串");
});

test("公共主题同步必须恢复壁纸，包括显式空值", () => {
  const hook = read("frontend", "src", "hooks", "useThemePreferences.ts");
  const apply = read("frontend", "src", "theme", "apply.ts");
  assert.ok(hook.includes("restoreThemePreferences(preferences)"), "两端必须走统一恢复逻辑");
  const wallpaperLine = apply.split("\n").find(line => line.includes("persistWallpaper(preferences.wallpaper)"));
  assert.ok(wallpaperLine?.includes("typeof preferences.wallpaper === 'string'"), "显式空值也必须应用以清除旧壁纸");
});

// ── 莫兰迪配色卡（2026-09-16）──────────────────────────────────────────────
// 色值是从用户给的色卡图里逐条读出来的，这里把 9 组钉死：以后谁改错一位数字、或者少抄一组，
// 都会在这里亮红灯（抄错色值只有肉眼能发现，测试是唯一的守门人）。
const VERIFIED_CARDS = [
  ["morandi-blue-sand", "#5D9AB4", "#F5D7C4"],
  ["morandi-deep-teal", "#324263", "#B0E4ED"],
  ["morandi-gray-cream", "#FCE5D7", "#728B9A"],
  ["morandi-mist-blue", "#5B83B8", "#FFD4EA"],
  ["morandi-violet-pink", "#6453A1", "#FDDCE4"],
  ["morandi-lilac-milk", "#72749A", "#FFF5DF"],
  ["morandi-rose-blue", "#D693A1", "#E2F5FF"],
  ["morandi-pink-rice", "#E16668", "#FFF4DD"],
  ["morandi-taupe-cream", "#BA8D8E", "#FAF2D9"],
];

test("配色卡：9 组齐全、色值合法、id 与色值都与抄录一致", () => {
  assert.equal(MORANDI_CARDS.length, 9, "色卡图上是 9 组");
  assert.equal(new Set(MORANDI_CARDS.map(c => c.id)).size, 9, "id 不能重复");
  for (const [id, from, to] of VERIFIED_CARDS) {
    const card = MORANDI_CARDS.find(c => c.id === id);
    assert.ok(card, `缺少配色卡 ${id}`);
    assert.equal(card.from, from, `${id} 的起始色抄错了`);
    assert.equal(card.to, to, `${id} 的结束色抄错了`);
    assert.ok(card.name && card.name.length >= 2, `${id} 要有名字`);
    for (const key of ["from", "to", "top", "bottom"]) {
      assert.match(card[key], /^#[0-9A-F]{6}$/i, `${id}.${key} 必须是 6 位 hex`);
    }
  }
  // 第 3 张的标签顺序与渐变方向相反（图上就是灰在上、米在下），这条例外得留着
  const reversed = MORANDI_CARDS.find(c => c.id === "morandi-gray-cream");
  assert.equal(reversed.top, reversed.to, "灰卡上端是右边那个色");
  assert.equal(reversed.bottom, reversed.from, "灰卡下端是左边那个色");
});

test("配色卡：渐变必须原样交给 wallpaperCssImage（包成 url() 就点不动）", () => {
  for (const card of MORANDI_CARDS) {
    const g = colorCardGradient(card);
    assert.match(g, /^linear-gradient\(180deg, #[0-9A-F]{6} 0%, #[0-9A-F]{6} 100%\)$/i, `${card.id} 必须是竖向渐变`);
    assert.equal(wallpaperCssImage(g), g, `${card.id} 的渐变被加工过就不是合法背景了`);
  }
  assert.equal(colorCardGradient(null), "", "缺参数不能抛，返回空串");
});

test("主题页用共享配色卡模块，不许自己另抄一份色值", () => {
  const themes = read("frontend", "src", "pages", "Themes.tsx");
  assert.ok(themes.includes("MORANDI_CARDS"), "主题页必须从共享模块取配色卡");
  assert.ok(themes.includes("colorCardGradient("), "渐变要由共享函数生成，页面不自己拼");
  // 页面里出现卡片色值 = 又抄了一份，抄错没人发现
  for (const [, from, to] of VERIFIED_CARDS) {
    assert.ok(!themes.includes(from) && !themes.includes(to), `Themes.tsx 不该硬编码 ${from}/${to}`);
  }
  // 数据源只有 engine/color-cards.mjs 一份：前端模块只转出，自己也别抄
  const cards = read("frontend", "src", "theme", "colorcards.mjs");
  assert.ok(cards.includes("engine/color-cards.mjs"), "前端配色卡必须转出引擎那一份");
  for (const [, from, to] of VERIFIED_CARDS) {
    assert.ok(!cards.includes(from) && !cards.includes(to), `前端模块不该再抄一份 ${from}/${to}`);
  }
  const source = read("engine", "color-cards.mjs");
  assert.ok(source.includes("linear-gradient(180deg"), "渐变方向要和原图一致（竖向）");
});

