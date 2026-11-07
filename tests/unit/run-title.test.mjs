// run 标题推导（2026-11-07）：看门狗报「哪件事」之前，先把各入口的信息压成一行 ≤40 字的标题。
// 六条优先级：显式 title → 派活任务 → 定时 label → 子代理/值班 name → 用户消息首句 → 「来源 · 时间」。
import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveRunTitle, RUN_TITLE_MAX } from "../../engine/run-title.mjs";

// 固定本地时间，避免测试机时区把兜底标题的 HH:mm 弄漂。
const AT = new Date(2026, 10, 7, 22, 31).getTime();
const chars = (s) => [...String(s)].length;

test("① 显式 title 优先于所有其它来源", () => {
  const title = deriveRunTitle({
    title: "整理桌面截图",
    task: "把昨天的会议纪要整理成要点",
    label: "每日复盘",
    name: "值班盯 CI",
    message: "请帮我修登录页",
    at: AT,
  });
  assert.equal(title, "整理桌面截图");
});

test("② 派活任务文本优先于 label/name/消息", () => {
  const title = deriveRunTitle({
    task: "把昨天的会议纪要整理成要点",
    label: "每日复盘",
    name: "值班盯 CI",
    message: "请帮我修登录页",
    at: AT,
  });
  assert.equal(title, "把昨天的会议纪要整理成要点");
});

test("③ 定时任务 label 优先于 name/消息", () => {
  const title = deriveRunTitle({ label: "每日复盘", name: "值班盯 CI", message: "请帮我修登录页", at: AT });
  assert.equal(title, "每日复盘");
});

test("④ 子代理/值班 name 优先于消息", () => {
  const title = deriveRunTitle({ name: "盯 CI 失败", message: "请帮我修登录页", at: AT });
  assert.equal(title, "盯 CI 失败");
});

test("⑤ 用户消息首句：去掉「帮我/请/麻烦」前缀，只取第一句", () => {
  assert.equal(
    deriveRunTitle({ message: "请帮我整理 D:\\桌面 上的截图。顺便备份一下", at: AT }),
    "整理 D:\\桌面 上的截图",
  );
  assert.equal(deriveRunTitle({ message: "麻烦看一下构建为什么挂了！日志在 logs/", at: AT }), "看一下构建为什么挂了");
  assert.equal(deriveRunTitle({ message: "能不能把登录页的按钮改成红色", at: AT }), "把登录页的按钮改成红色");
});

test("⑥ 兜底：来源 · 时间（认得的来源说人话）", () => {
  assert.equal(deriveRunTitle({ surface: "wechat", at: AT }), "微信 · 22:31");
  assert.equal(deriveRunTitle({ surface: "web", at: AT }), "网页 · 22:31");
  assert.equal(deriveRunTitle({ at: AT }), "任务 · 22:31");
  // 认不出来的来源原样截断，不编造
  assert.equal(deriveRunTitle({ surface: "sms-gateway-长名字来源", at: AT }), "sms-gateway… · 22:31");
});

test("空输入不报错：落回「任务 · HH:mm」", () => {
  assert.equal(deriveRunTitle({ title: "   ", task: "\n\n", label: "", name: null, message: "", at: AT }), "任务 · 22:31");
  assert.match(deriveRunTitle(), /^任务 · \d{2}:\d{2}$/);
});

test("噪音清理：markdown 标题/加粗/链接/列表都去掉，换行压成一行", () => {
  const title = deriveRunTitle({
    task: "## 帮我修一下 **登录页**\n\n- 先看 [日志](https://example.com/log)\n- 再改样式",
    at: AT,
  });
  assert.equal(title, "帮我修一下 登录页 先看 日志 再改样式");
  assert.doesNotMatch(title, /[#*\[\]\n]/);
});

test("命令噪声：代码围栏、cd 前缀、PS 提示符、bash: 前缀都不进标题", () => {
  assert.equal(deriveRunTitle({ task: "```bash\ncd /d/pi-web && npm test\n```", at: AT }), "npm test");
  assert.equal(deriveRunTitle({ task: "cd /d/pi-web\nnpm run build", at: AT }), "npm run build");
  assert.equal(deriveRunTitle({ task: "PS C:\\Users\\x> npm run build", at: AT }), "npm run build");
  assert.equal(deriveRunTitle({ task: "bash: pytest -q", at: AT }), "pytest -q");
});

test("文件名/路径里的下划线与波浪号保留（不能当 markdown 强调删掉）", () => {
  assert.equal(deriveRunTitle({ task: "整理 my_photos 文件夹里的截图", at: AT }), "整理 my_photos 文件夹里的截图");
  assert.equal(deriveRunTitle({ task: "检查 engine/run_store.mjs 的改动", at: AT }), "检查 engine/run_store.mjs 的改动");
});

test("协议标签（【…】）不算任务名，去掉后再取正文", () => {
  assert.equal(deriveRunTitle({ task: "【只核对不执行】列出要动的文件清单", at: AT }), "列出要动的文件清单");
});

test("截断：显式标题 ≤40 字，派活/消息 ≤30 字，超长补省略号", () => {
  const explicit = deriveRunTitle({ title: "标题".repeat(30), at: AT });
  assert.equal(chars(explicit), RUN_TITLE_MAX);
  assert.ok(explicit.endsWith("…"));

  const task = deriveRunTitle({ task: "任务".repeat(30), at: AT });
  assert.equal(chars(task), 30);
  assert.ok(task.endsWith("…"));

  const message = deriveRunTitle({ message: "消息".repeat(30), at: AT });
  assert.equal(chars(message), 30);
  assert.ok(message.endsWith("…"));
});

test("任何来源推出来的标题都 ≤40 字且单行", () => {
  const inputs = [
    { task: "很长的任务描述".repeat(20), at: AT },
    { label: "很长的定时任务标签".repeat(10), at: AT },
    { name: "很长的子代理名字".repeat(10), at: AT },
    { message: "这是一段很长的用户消息".repeat(10), at: AT },
    { surface: "wechat", at: AT },
  ];
  for (const input of inputs) {
    const title = deriveRunTitle(input);
    assert.ok(title.length > 0, "标题不能为空");
    assert.ok(chars(title) <= RUN_TITLE_MAX, `超长：${title}`);
    assert.doesNotMatch(title, /\n/);
  }
});
