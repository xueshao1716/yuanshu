import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("APP_VERSION 从唯一来源派生，且 CHANGELOG 有对应条目", () => {
  const src = fs.readFileSync(path.join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  // 2026-11-05：公告/更新日志拉取已拆到 chat-notices.mjs，CHANGELOG 在那边读。
  const noticesSrc = fs.readFileSync(path.join(ROOT, "engine", "chat-notices.mjs"), "utf8");
  const cl = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "version.json"), "utf8"));

  // 不能再手写常量：手写的那一版实际停在 2.7.1 两天，期间发了一整批功能都没动过。
  assert.doesNotMatch(src, /APP_VERSION\s*=\s*"\d/, "APP_VERSION 不得再写死字面量，必须从 version.json 派生");
  assert.match(src, /const APP_VERSION = PRODUCT_VERSION/, "APP_VERSION 必须取自 engine/version.mjs 的 PRODUCT_VERSION");

  assert.ok(cl.includes(`## [${version}]`), `CHANGELOG 必须有 ## [${version}]`);
  assert.ok(noticesSrc.includes('path.join(import.meta.dirname, "..", "CHANGELOG.md")'), "看板必须读仓库根 CHANGELOG.md");
});
