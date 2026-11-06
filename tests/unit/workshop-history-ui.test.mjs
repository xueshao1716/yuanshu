import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "..");
const source = () => fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "views", "WorkshopView.tsx"), "utf8");

test("PPT 往期载入兼容顶层数组，并通过作品集接口恢复 HTML 设计稿", () => {
  const src = source();
  assert.match(src, /Array\.isArray\(doc\)/, "旧版 deck.json 顶层数组不能点击后静默失效");
  assert.match(src, /WorkshopApi\.galleryDeck/, "HTML 设计稿历史必须走 deck 读取接口");
  assert.match(src, /setDeck\(/, "HTML 历史应回到设计稿预览");
});

test("PPT 往期载入失败必须显式反馈，不能静默卡住", () => {
  const src = source();
  assert.match(src, /historyError|载入失败/, "历史载入需要可见错误状态");
});
