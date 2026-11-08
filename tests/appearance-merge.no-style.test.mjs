import { mergeAppearance } from "../engine/appearance-merge.mjs";
const main = { appearance:"皮肤白净偏冷调", hairstyle:"齐耳短发，深棕近黑", clothing:"灰色针织上衣、黑色短裤", scenarioOutfits:"" };
function show(name, aux) {
  const r = mergeAppearance({ main, aux });
  const hit = ["赛博","插画","光晕","星空蓝","连帽衫","徽章"].filter((w) => r.text.includes(w));
  console.log(`\n[${name}]`);
  console.log("  text:", r.text);
  console.log("  污染词进入 text:", hit.length ? "❌ " + hit.join(",") : "✅ 无");
  console.log("  style 标记(仅留痕):", r.supplements.filter(s=>s.kind==="style").map(s=>s.text).join(" | ") || "无");
  console.log("  丢弃:", r.dropped.map(d=>`${d.text}(${d.reason})`).join(" | ") || "无");
}
show("辅=原赛博文件", `及肩深色短发，发梢泛星空蓝光
眼睛温暖明亮，笑起来有一点弯
深色连帽衫，领口一枚发光圆形徽章
整体安静温暖，赛博朋克 × 治愈系，高质量插画，柔和光晕`);
show("辅=有人又塞画风词", "赛博朋克风格插画，柔和光晕，眼神安静");
show("辅=纯神态", "笑起来眼睛会弯一点点");
show("主缺失时辅顶项", null);
