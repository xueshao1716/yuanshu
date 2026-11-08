import test from "node:test";
import assert from "node:assert/strict";
import { mergeAppearance } from "../engine/appearance-merge.mjs";

const main = {
  appearance: "皮肤白净偏冷调",
  hairstyle: "齐耳短发，深棕近黑",
  clothing: "灰色针织上衣、黑色短裤",
  scenarioOutfits: "",
};

const FORBIDDEN = ["赛博", "插画", "光晕", "星空蓝", "连帽衫", "徽章", "治愈系"];

const assertClean = (text, label) => {
  const hit = FORBIDDEN.filter((w) => text.includes(w));
  assert.deepEqual(hit, [], label + "：这些词不该进母提示词 -> " + hit.join(",") + "\n实际:" + text);
};

test("辅助文件里的画风/配色/单品一律不进母提示词", () => {
  const r = mergeAppearance({
    main,
    aux: "及肩深色短发，发梢泛星空蓝光\n深色连帽衫，领口一枚发光圆形徽章\n整体安静温暖，赛博朋克 × 治愈系，高质量插画，柔和光晕",
  });
  assertClean(r.text, "原赛博文件");
  assert.match(r.text, /齐耳短发/);
  assert.match(r.text, /灰色针织上衣/);
  const styles = r.supplements.filter((s) => s.kind === "style").map((s) => s.text);
  assert.ok(styles.some((t) => t.includes("赛博朋克")), "style 词应保留在 supplements 里供排查");
});

test("后续再往外观.md 塞画风词，也不会污染", () => {
  const r = mergeAppearance({ main, aux: "赛博朋克风格插画，柔和光晕，眼神安静" });
  assertClean(r.text, "二次塞词");
  assert.match(r.text, /眼神安静/);
});

test("纯神态细节正常追加", () => {
  const r = mergeAppearance({ main, aux: "笑起来眼睛会弯一点点" });
  assertClean(r.text, "纯神态");
  assert.match(r.text, /笑起来眼睛会弯一点点/);
});

test("主设定齐全时，辅助不覆盖发型/服装", () => {
  const r = mergeAppearance({ main, aux: "及肩长发，深色连帽衫" });
  assert.doesNotMatch(r.text, /及肩/);
  assert.doesNotMatch(r.text, /连帽衫/);
  assert.match(r.text, /齐耳短发/);
});
