// 正文 markdown 图片的键盘可达（2026-11-13）：
// 以前只有鼠标/触摸能点开全屏，Tab 停不到图上。这里用静态断言守住"可聚焦容器 + Enter/Space
// 触发同一条查看器路径"，避免以后重构 Markdown.tsx 时又退回去。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = readFileSync(join(ROOT, "frontend", "src", "components", "chat", "Markdown.tsx"), "utf8");

test("正文图片套在可聚焦容器里：button + tabIndex + role", () => {
  assert.match(SRC, /function MarkdownImage/, "图片要有独立组件，别直接裸 img");
  assert.match(SRC, /<button[\s\S]{0,400}tabIndex=\{0\}/, "容器必须能 Tab 到");
  assert.match(SRC, /role="button"/, "读屏要认成按钮");
  assert.match(SRC, /<img[\s\S]{0,200}ref=\{imgRef\}/, "img 自身要留 ref，键盘触发时把 click 转给它");
});

test("Enter / Space 触发与鼠标点击同一条路径（转发 click 给 img）", () => {
  assert.match(SRC, /onKeyDown=\{event => \{/, "要有键盘处理");
  assert.match(SRC, /event\.key === 'Enter'/, "Enter 要能开图");
  assert.match(SRC, /event\.key === ' '/, "Space 要能开图");
  assert.match(SRC, /event\.preventDefault\(\)/, "别让 Space 顺手滚页面");
  assert.match(SRC, /imgRef\.current\?\.click\(\)/, "转发给 img：外面 onClick 代理只认 IMG 目标");
});

test("aria-label 用 alt；alt 为空时有兜底文案", () => {
  assert.match(SRC, /aria-label=\{label \? `查看大图：\$\{label\}` : '查看大图'\}/, "读屏要有名字");
  assert.match(SRC, /alt=\{label\}/, "img 的 alt 沿用同一份文案");
});

test("正文图片仍然走原来的查看器（没新开一套）", () => {
  assert.match(SRC, /return <MarkdownImage src=\{finalSrc\} alt=\{alt \|\| ''\} \/>/, "替换点要在 img 分支里");
  assert.doesNotMatch(SRC, /<ImageViewer/, "不要在这里另开查看器：统一交给 Message 的代理/画廊");
});
