// 选项卡片（2026-11-17，学 A2UI）：小语要问你时，出一张能点的卡——
// 几个选项 + 「自己填」+ 「跳过」，点完就当你的下一句话发出去，不用打字一轮轮回。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeChoice, choiceReplyText, CHOICE_EVENT } from "../../frontend/src/lib/choice-reply.mjs";
import { YUANSHU_PROTOCOL } from "../../engine/yuanshu-protocol.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

test("校验：选项去空去重、最多 6 个，字符串和对象都认；少于 2 个不成卡", () => {
  const c = normalizeChoice({ type: "choice", question: " 测试写多少？ ", options: ["最少", { label: "标准", desc: "覆盖主流程" }, " ", "最少", "a", "b", "c", "d"] });
  assert.equal(c.question, "测试写多少？");
  assert.deepEqual(c.options.map(o => o.label), ["最少", "标准", "a", "b", "c", "d"]);
  assert.equal(c.options[1].desc, "覆盖主流程");
  assert.equal(c.custom, true, "默认允许自己填");
  assert.equal(c.skip, true, "默认可以跳过——问题永远允许不答");
  assert.equal(normalizeChoice({ type: "choice", question: "q", options: ["only"] }), null);
  assert.equal(normalizeChoice({ type: "choice", question: "", options: ["a", "b"] }), null);
  const strict = normalizeChoice({ type: "choice", question: "q", options: ["a", "b"], custom: false, skip: false });
  assert.equal(strict.custom, false);
  assert.equal(strict.skip, false);
});

test("回复文字带上问题，模型才知道答的是哪一问", () => {
  assert.equal(choiceReplyText({ question: "测试写多少？", label: "标准" }), "关于「测试写多少？」：我选「标准」");
  assert.equal(choiceReplyText({ question: "测试写多少？", custom: "  只测登录 " }), "关于「测试写多少？」：只测登录");
  assert.match(choiceReplyText({ question: "测试写多少？", skip: true }), /跳过.*你按自己的判断/);
  assert.equal(choiceReplyText({ question: "q", custom: "   " }), "");
});

test("卡片组件：choice 渲染选项/自己填/跳过，点了发事件，答过就锁住", () => {
  const ui = read("frontend", "src", "components", "GenUI.tsx");
  assert.match(ui, /case 'choice'/);
  assert.match(ui, /normalizeChoice/);
  assert.match(ui, /CHOICE_EVENT/);
  assert.match(ui, /跳过/);
  assert.match(ui, /自己填/);
  assert.match(ui, /answered/, "点过之后要锁住，防止重复发");
  assert.match(ui, /<button\b/, "选项必须是真按钮（键盘可达）");
});

test("聊天区监听选项事件，走正常发送（流式中不发）", () => {
  const chat = read("frontend", "src", "components", "chat", "ChatArea.tsx");
  assert.equal(CHOICE_EVENT, "pi-chat-reply");
  assert.match(chat, /addEventListener\(CHOICE_EVENT/);
  assert.match(chat, /removeEventListener\(CHOICE_EVENT/);
  assert.match(chat, /sendRef\.current\(/);
});

test("协议告诉模型：要你选的时候出 choice 卡，别一轮轮文字追问", () => {
  assert.match(YUANSHU_PROTOCOL, /dsh-ui/);
  assert.match(YUANSHU_PROTOCOL, /"type":"choice"/);
});

test("复现：代码块语言名要认连字符，否则 dsh-ui 被截成 dsh、GenUI 从来没渲染过", () => {
  const md = read("frontend", "src", "components", "chat", "Markdown.tsx");
  const re = new RegExp(md.match(/const match = \/(.+?)\/\.exec/)[1]);
  assert.equal(re.exec("language-dsh-ui")?.[1], "dsh-ui");
  assert.equal(re.exec("language-mermaid")?.[1], "mermaid");
});

test("dsh-ui 卡片不套代码块 <pre>（否则整卡变代码底色+等宽字）", () => {
  const md = read("frontend", "src", "components", "chat", "Markdown.tsx");
  assert.match(md, /pre\(\{ children, node/);
  assert.match(md, /includes\('language-dsh-ui'\)\) return <>\{children\}<\/>/);
});

test("选项按钮文字要换行（全局 button 是 nowrap，手机上会撑出屏幕）", () => {
  const g = read("frontend", "src", "components", "GenUI.tsx");
  assert.match(g, /w-full min-w-0 text-left whitespace-normal break-words/);
});
