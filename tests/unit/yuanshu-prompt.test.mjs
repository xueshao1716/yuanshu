import { test } from "node:test";
import assert from "node:assert/strict";
import {
  YUANSHU_SECTION_ORDER,
  assemblePrompt,
  replaceSection,
  projectRuntime,
  prependAssembledSystem,
  buildYuanshuSections,
} from "../../engine/yuanshu-prompt.mjs";

test("assemblePrompt：空段跳过，按命名区段顺序拼接", () => {
  const text = assemblePrompt({
    protocol: "独立干活",
    time: "2026-09-07 15:00",
    persona: "小语",
    memory: "",
  });
  assert.match(text, /### section:persona\n小语/);
  assert.match(text, /### section:protocol\n独立干活/);
  assert.match(text, /### section:time\n2026-09-07/);
  assert.ok(!/section:memory/.test(text));
  assert.ok(text.indexOf("section:persona") < text.indexOf("section:protocol"));
  assert.ok(text.indexOf("section:protocol") < text.indexOf("section:time"));
  assert.ok(YUANSHU_SECTION_ORDER.includes("runtime"));
});

test("replaceSection 只换一区，其它不动", () => {
  const next = replaceSection({ persona: "A", protocol: "B" }, "protocol", "B2");
  assert.equal(next.persona, "A");
  assert.equal(next.protocol, "B2");
  assert.match(assemblePrompt(next), /section:protocol\nB2/);
});

test("projectRuntime：没变就不提交", () => {
  const a = projectRuntime("cwd=D:/ws", "cwd=D:/ws");
  assert.equal(a.changed, false);
  assert.equal(a.snapshot, "cwd=D:/ws");
  const b = projectRuntime("cwd=D:/ws", "cwd=D:/other");
  assert.equal(b.changed, true);
  assert.equal(b.snapshot, "cwd=D:/other");
});

test("prependAssembledSystem 把分区打成一条 system", () => {
  const hist = [{ role: "user", content: "hi" }];
  const out = prependAssembledSystem(hist, { protocol: "独立干活", time: "此刻" });
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "system");
  assert.match(out[0].content, /section:protocol/);
  assert.equal(out[1].content, "hi");
});

test("buildYuanshuSections：协议常驻，闲聊不背经验", () => {
  const idle = buildYuanshuSections({
    message: "嗯",
    skills: [{ name: "aigc-video-production", desc: "视频" }],
    experience: ["【经验】x"],
    fullMemory: ["【记忆】y"],
    persona: "本轮由 deepseek 驱动",
    time: "2026-09-07",
  });
  const blob = assemblePrompt(idle);
  assert.match(blob, /section:protocol/);
  assert.match(blob, /generate_video/);
  assert.match(blob, /section:persona/);
  assert.match(blob, /section:time/);
  assert.ok(!/【经验】/.test(blob));
  const task = buildYuanshuSections({
    message: "做个视频",
    skills: [{ name: "aigc-video-production", desc: "视频" }],
    experience: ["【经验】x"],
    fullMemory: ["【记忆】y"],
  });
  // 2026-11-13（任务 B）：闸门放行的经验/记忆不再进 system，改由 memoryNote 贴末尾。
  assert.match(task.memoryNote, /【经验】/);
  assert.match(task.memoryNote, /【记忆】/);
  assert.ok(!/【经验】/.test(assemblePrompt(task)), "system 只留稳定记忆，经验索引不再进 system");
});

test("buildYuanshuSections：PPT 主题默认走快速生成并交付文件", () => {
  const sections = buildYuanshuSections({
    message: "做一个关于定西洋芋的宣传ppt",
    skills: [{ name: "ppt-generator", desc: "智能 PPT 幻灯片生成" }],
  });
  // 2026-11-13（任务 B）：PPT 交付指令属于"这轮用得上什么"，进末尾状态块（turnSkills），不进 system。
  assert.match(sections.turnSkills, /快速生成/);
  assert.match(sections.turnSkills, /可下载的 \.pptx/);
  assert.match(sections.turnSkills, /跳过可选的大纲确认/);
  assert.ok(!/\.pptx/.test(assemblePrompt(sections)), "system 里不该再带只跟本轮消息有关的交付指令");
});
