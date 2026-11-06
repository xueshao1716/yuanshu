import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVideoPrompt, composeVideoShot, VIDEO_SCENES, VIDEO_GRAMMARS, VIDEO_EXAMPLES } from "../../frontend/src/lib/video-prompt.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("自定义格子精简档仍要留下主体动作场景，不能丢规格", () => {
  const p = buildVideoPrompt({
    subject: "韩立",
    action: "转身遁入夜色",
    scene: "空旷山道",
    lighting: "冷月光",
    camera: "缓推近",
    style: "电影感写实",
    quality: "720P 清晰",
    constraint: "无字幕无BGM无变形",
    seconds: "10",
    frame: "16:9",
    richness: "lite",
  });
  assert.match(p, /韩立/);
  assert.match(p, /转身遁入夜色/);
  assert.match(p, /空旷山道/);
  assert.match(p, /冷月光/);
  assert.match(p, /缓推近/);
  assert.match(p, /无字幕|无BGM/);
  assert.match(p, /10/);
  assert.match(p, /16:9/);
});

test("标准档按起承转合写时间轴，不复印万能公式", () => {
  const p = buildVideoPrompt({
    subject: "女主",
    action: "抬头看雨",
    scene: "老巷",
    lighting: "霓虹湿地面",
    camera: "跟拍",
    style: "雨巷电影感",
    quality: "720P",
    constraint: "无烧录字幕",
    seconds: "10",
    frame: "9:16",
    richness: "standard",
    beats: "0-2秒 起：驻足。2-5秒 承：抬头。5-8秒 转：看雨。8-10秒 合：迈步离开",
    memory: "第6秒：雨丝打在睫毛上",
  });
  assert.match(p, /总览/);
  assert.match(p, /0-2|起/);
  assert.match(p, /记忆|第6秒/);
  assert.match(p, /锁定|约束/);
  assert.match(p, /9:16/);
  assert.ok(!p.includes("万能公式"), "标准档禁止再贴一遍格子");
  assert.ok(!p.includes("停在一个可读画面"), "禁止程序空话收尾");
});

test("仙侠镜头卡必须有衣服料子、灯的形制、雾怎么走，不能只写青衣修士", () => {
  const card = VIDEO_SCENES.xianxia;
  const blob = JSON.stringify(card);
  assert.match(blob, /交领|洗白|旧玉/);
  assert.match(blob, /豆油灯|石龛/);
  assert.match(blob, /贴地|山雾/);
  const p = buildVideoPrompt({ sceneKey: "xianxia", richness: "standard" });
  assert.match(p, /交领|洗白|旧玉/);
  assert.match(p, /0-2/);
  assert.match(p, /记忆|第\d秒/);
  assert.ok(!p.includes("万能公式"));
});

test("场景模板覆盖短视频钩子和电影感", () => {
  const keys = Object.keys(VIDEO_SCENES);
  assert.ok(keys.includes("hook"));
  assert.ok(keys.includes("cinematic"));
  assert.ok(VIDEO_SCENES.hook.frame === "9:16");
  assert.ok(VIDEO_SCENES.cinematic.frame === "16:9");
});

test("改了主体动作场景就不能再贴原镜头卡的风衣雨街", () => {
  const p = buildVideoPrompt({
    sceneKey: "cinematic",
    subject: "小语",
    action: "在工位写代码",
    scene: "夜里的书房",
    richness: "standard",
  });
  assert.match(p, /小语/);
  assert.match(p, /写代码/);
  assert.match(p, /书房/);
  assert.ok(!p.includes("深灰风衣"), "换了人还写风衣就是填充不智能");
  assert.ok(!p.includes("雨后空街"), "换了地点还写空街就是填充不智能");
});

test("工坊提示词面板默认走标准档，把镜头卡交给生成器", () => {
  const panel = readFileSync(join(ROOT, "frontend", "src", "components", "story", "VideoPrompt.tsx"), "utf8");
  assert.ok(panel.includes('useState') && panel.includes("standard"), "默认标准档");
  assert.ok(panel.includes("sceneKey"), "生成时要带镜头卡");
  assert.ok(panel.includes("PromptSmartFill") || panel.includes("expandPrompt") || panel.includes("智能填充"), "要能按一句话智能填");
  assert.ok(!panel.includes("万能公式 ·"), "界面别再把检查单当标题");
});

test("运镜骨架是拍法不是故事，至少十种，不能写死风衣雨街", () => {
  const keys = Object.keys(VIDEO_GRAMMARS);
  assert.ok(keys.length >= 10, `骨架太少：${keys.join(",")}`);
  assert.ok(keys.includes("free"), "默认要有自由骨架");
  assert.ok(keys.includes("hook") && keys.includes("cinematic"));
  const blob = JSON.stringify(VIDEO_GRAMMARS);
  assert.ok(!blob.includes("青衣修士"), "仙侠故事不该写进骨架");
  assert.ok(!blob.includes("深灰风衣"), "雨街故事不该写进骨架");
  assert.ok(!blob.includes("油纸伞"), "雨巷故事不该写进骨架");
  for (const g of Object.values(VIDEO_GRAMMARS)) {
    assert.equal(g.subject || "", "", `${g.name} 不该预填主体`);
    assert.equal(g.action || "", "", `${g.name} 不该预填动作`);
    assert.equal(g.scene || "", "", `${g.name} 不该预填地点`);
  }
});

test("示例成稿单独收着，点骨架不能覆盖已填主体", () => {
  assert.ok(VIDEO_EXAMPLES.xianxia);
  assert.match(JSON.stringify(VIDEO_EXAMPLES.xianxia), /交领|旧玉/);
  const panel = readFileSync(join(ROOT, "frontend", "src", "components", "story", "VideoPrompt.tsx"), "utf8");
  assert.match(panel, /运镜骨架/);
  assert.match(panel, /示例成稿/);
  assert.match(panel, /useState<SceneKey>\('free'\)/);
  const grammarFn = panel.includes("pickGrammar")
    ? panel.slice(panel.indexOf("pickGrammar"), panel.indexOf("pickExample") === -1 ? panel.length : panel.indexOf("pickExample"))
    : "";
  assert.ok(panel.includes("pickGrammar"), "点骨架走 pickGrammar");
  assert.ok(!grammarFn.includes("setSubject"), "骨架不许把主体改成示例里的人");
});

test("骨架上填了人也不能丢掉运镜细节和物理", () => {
  const p = buildVideoPrompt({
    sceneKey: "cinematic",
    subject: "韩立",
    action: "走过山道",
    scene: "夜色空山",
    richness: "standard",
  });
  assert.match(p, /韩立/);
  assert.match(p, /山道|空山/);
  assert.match(p, /侧面|缓跟/);
  assert.match(p, /【物理】/);
  assert.match(p, /冷暖|材质|步/);
  assert.ok(!p.includes("深灰风衣"));
  assert.ok(!p.includes("中全景·第三人称·稳定器") || p.includes("侧面"), "不能退回万能跟拍");
});

test("双人对谈和口播都要有口型，对谈用正反打不能禁第二个人", () => {
  assert.ok(VIDEO_GRAMMARS.dialogue, "要有双人对谈骨架");
  assert.ok(VIDEO_GRAMMARS.talk, "口播还在");
  const p = buildVideoPrompt({
    sceneKey: "dialogue",
    subject: "两人在茶馆对谈",
    action: "一问一答",
    scene: "旧茶馆",
    richness: "standard",
  });
  assert.match(p, /过肩|正反打/);
  assert.match(p, /口型/);
  assert.match(p, /茶馆/);
  assert.ok(!p.includes("无多余人物"), "对谈不能写成禁止第二个人");
  const talk = buildVideoPrompt({
    sceneKey: "talk",
    subject: "主播",
    action: "对着镜头说话",
    scene: "干净背景",
    richness: "standard",
  });
  assert.match(talk, /口型|近景/);
});

test("青衣修士配急推骨架，光影要跟山道走，不能还贴硬顶光", () => {
  const shot = composeVideoShot(VIDEO_GRAMMARS.hook, {
    subject: "青衣修士",
    action: "转身遁入夜色，衣袂扬起后只剩空山",
    scene: "空旷山道，远处孤灯",
  });
  assert.match(shot.lighting, /月|孤灯|油灯/);
  assert.ok(!shot.lighting.includes("硬顶光"), "山道不能用地铁硬顶光");
  assert.match(shot.camera, /急推|正脸/);
  assert.match(shot.style, /竖屏|短视频/);
  assert.match(shot.style, /古装|山道|布料/);
  assert.equal(shot.frame, "9:16");
});

test("改地点且光影还是自动写的，要再合成；人手改过的不动", () => {
  const hook = VIDEO_GRAMMARS.hook;
  const a = composeVideoShot(hook, { scene: "晚高峰拥挤车厢" });
  assert.match(a.lighting, /顶灯|冷白/);
  const b = composeVideoShot(hook, { scene: "青石板老巷" });
  assert.match(b.lighting, /阴天|漫射|巷/);
  assert.ok(!b.lighting.includes("硬顶光"));
  const kept = composeVideoShot(hook, {
    scene: "空旷山道",
    lighting: "人手写的红光",
    lightingLocked: true,
  });
  assert.equal(kept.lighting, "人手写的红光");
  assert.match(kept.camera, /急推/);
});

test("点骨架要把合成写进格子，不能原样拷芯片上的光", () => {
  const panel = readFileSync(join(ROOT, "frontend", "src", "components", "story", "VideoPrompt.tsx"), "utf8");
  assert.match(panel, /composeVideoScript/);
  const grammarFn = panel.slice(panel.indexOf("pickGrammar"), panel.indexOf("pickExample"));
  assert.ok(grammarFn.includes("composeVideoShot") || grammarFn.includes("composeVideoScript"), "点骨架要按人×拍法现写");
  assert.ok(!grammarFn.includes("setSubject"), "骨架仍不许改主体");
});

test("青衣修士配急推，整段脚本要写遁入空山，不能再演地铁对镜头", () => {
  const p = buildVideoPrompt({
    sceneKey: "hook",
    subject: "青衣修士",
    action: "转身遁入夜色，衣袂扬起后只剩空山",
    scene: "空旷山道，远处孤灯",
    lighting: "冷月光切开半张脸",
    camera: "先藏正脸，0.5秒急推到眼睛",
    style: "竖屏短视频写实，古装布料和山道要能认",
    richness: "standard",
  });
  assert.match(p, /青衣修士/);
  assert.match(p, /遁入|衣袂|空山/);
  assert.match(p, /冷月光/);
  assert.match(p, /急推/);
  assert.match(p, /【物理】/);
  assert.ok(!p.includes("对上镜头"), "遁入夜色不能写成对镜头表演");
  assert.ok(!p.includes("帽檐"), "山道修士不能还戴棒球帽檐");
  assert.ok(!p.includes("硬顶光"), "物理光学不能还贴地铁硬顶光");
  assert.ok(!p.includes("只留顶光和肩膀"), "收束要回到空山，不能回到车厢肩膀");
  assert.ok(!/在空旷山道，远处孤灯里/.test(p), "地点不要被「里」包成一句病句");
});
