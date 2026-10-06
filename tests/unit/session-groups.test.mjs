// 会话三主分组 + 空会话清扫（临时目录造数，不碰真实 ~/.pi 会话）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifySessionGroup, isJunkSession, isListedGroup, planSweep } from "../../engine/session-groups.mjs";
import { initSessionFiles, getSessionList, invalidateSessionCache, parseSessionFile } from "../../engine/session-files.mjs";

const WS = "D:\\pi-workspace";
const HOME = "C:\\Users\\xuexiaofeng";
const PIWEB = "D:\\pi-web";

test("classifySessionGroup：已写入的 group 优先于 cwd/名字启发式", () => {
  assert.equal(classifySessionGroup({ name: "[真测] x", cwd: WS, group: "workspace", workspaceCwd: WS }), "workspace");
  assert.equal(classifySessionGroup({ name: "日常", cwd: HOME, group: "terminal", workspaceCwd: WS }), "terminal");
  assert.equal(classifySessionGroup({ name: "日常", cwd: WS, group: "test", workspaceCwd: WS }), "test");
});

test("classifySessionGroup：三主分组 + 外部 Cursor 会话不进侧栏", () => {
  assert.equal(classifySessionGroup({ name: "修小说工坊", cwd: WS, workspaceCwd: WS }), "workspace");
  assert.equal(classifySessionGroup({ name: "[真测] 只回复两个字:在线", cwd: WS, workspaceCwd: WS }), "test");
  assert.equal(classifySessionGroup({ name: "真测·通道", cwd: WS, workspaceCwd: WS }), "test");
  assert.equal(classifySessionGroup({ name: "E2E ping", cwd: PIWEB, workspaceCwd: WS }), "test");
  assert.equal(classifySessionGroup({ name: "回复严格仅这几个字：OK-GEMINI", cwd: PIWEB, workspaceCwd: WS }), "test");
  // 09-04 修复后语义：家目录 cwd 不再强制 foreign；只有杂音命名才藏。
  // 伙伴的终端会话（cwd=HOME）必须进侧栏 —— “看不见正在聊的会话”事故的回归测试。
  assert.equal(classifySessionGroup({ name: "请只回复 OK", cwd: HOME, workspaceCwd: WS }), "test");
  assert.equal(classifySessionGroup({ name: "那你就做一轮", cwd: HOME, workspaceCwd: WS }), "terminal");
  assert.equal(classifySessionGroup({ name: "小语 · 外部联系", cwd: HOME, workspaceCwd: WS }), "terminal");
  assert.equal(classifySessionGroup({ name: "微信联系人 张三", cwd: HOME, workspaceCwd: WS }), "terminal");
  assert.equal(classifySessionGroup({ name: "TUI 会话", cwd: PIWEB, workspaceCwd: WS }), "terminal");
  assert.equal(classifySessionGroup({ name: "murmur-web看看这个项目", cwd: HOME, workspaceCwd: WS }), "terminal"); // 09-04：家目录正常项目会话可见，不再藏
  assert.equal(classifySessionGroup({ name: "subagent-worker-10cdc346-1", cwd: HOME, workspaceCwd: WS }), "foreign");
  assert.equal(classifySessionGroup({ name: "cursor提示This model", cwd: HOME, workspaceCwd: WS }), "foreign");
});

test("isListedGroup：侧栏只展示 对话 / 微信 / 终端 / 真测", () => {
  assert.equal(isListedGroup("workspace"), true);
  assert.equal(isListedGroup("test"), true);
  assert.equal(isListedGroup("terminal"), true);
  assert.equal(isListedGroup("foreign"), false);
  assert.equal(isListedGroup("other"), false);
});

test("isJunkSession：空壳/真测残渣/工坊一枪可清，置顶和外部联系不可清", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  const old = "2026-09-01T00:00:00.000Z";
  const fresh = "2026-09-04T11:50:00.000Z";
  const base = { pinned: false, now, minAgeMs: 60 * 60 * 1000 };

  assert.equal(isJunkSession({ name: "新会话", messageCount: 0, updatedAt: old, ...base }), true);
  assert.equal(isJunkSession({ name: "hi", messageCount: 1, updatedAt: old, ...base }), true);
  assert.equal(isJunkSession({ name: "[真测] 请只回复 OK", messageCount: 2, group: "test", updatedAt: old, ...base }), true);
  assert.equal(isJunkSession({ name: "你是 ppt-html 技能的执行者。用", messageCount: 1, updatedAt: old, ...base }), true);
  assert.equal(isJunkSession({ name: "回复严格仅这几个字：OK-TUI-VER", messageCount: 1, updatedAt: old, ...base }), true);

  assert.equal(isJunkSession({ name: "新会话", messageCount: 0, updatedAt: fresh, ...base }), false, "未过冷却的空会话先留着");
  assert.equal(isJunkSession({ name: "小语 · 外部联系", messageCount: 1, updatedAt: old, ...base }), false);
  assert.equal(isJunkSession({ name: "新会话", messageCount: 0, updatedAt: old, pinned: true, now, minAgeMs: 0 }), false);
  assert.equal(isJunkSession({ name: "修情绪系统", messageCount: 12, updatedAt: old, ...base }), false);
  assert.equal(isJunkSession({ name: "murmur-web看看这个项目", messageCount: 34, group: "foreign", updatedAt: old, ...base }), false);
});

test("planSweep：只返回垃圾 id，dryRun 与正式名单一致", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  const old = "2026-09-01T00:00:00.000Z";
  const sessions = [
    { id: "keep-work", name: "修小说", messageCount: 8, updatedAt: old, group: "workspace" },
    { id: "keep-ext", name: "小语 · 外部联系", messageCount: 187, updatedAt: old, group: "terminal" },
    { id: "junk-hi", name: "hi", messageCount: 1, updatedAt: old, group: "workspace" },
    { id: "junk-test", name: "[真测] 在线", messageCount: 1, updatedAt: old, group: "test" },
    { id: "pinned-empty", name: "新会话", messageCount: 0, updatedAt: old, group: "workspace" },
  ];
  const plan = planSweep(sessions, { now, minAgeMs: 3600_000, pinnedIds: new Set(["pinned-empty"]) });
  assert.deepEqual(plan.ids.sort(), ["junk-hi", "junk-test"]);
  assert.equal(plan.kept, 3);
});

test("parseSessionFile 读出 session_info.group；列表对 foreign 打标", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sess-"));
  try {
    const wsDir = path.join(root, "ws");
    const homeDir = path.join(root, "home");
    fs.mkdirSync(wsDir);
    fs.mkdirSync(homeDir);
    const workFile = path.join(wsDir, "1_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl");
    const extFile = path.join(homeDir, "2_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl");
    const curFile = path.join(homeDir, "3_cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl");
    fs.writeFileSync(workFile, [
      JSON.stringify({ type: "session", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", timestamp: "2026-09-01T00:00:00.000Z", cwd: WS }),
      JSON.stringify({ type: "session_info", name: "工作A", group: "workspace", timestamp: "2026-09-01T00:00:00.000Z" }),
      JSON.stringify({ type: "message", timestamp: "2026-09-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "继续改工坊" }] } }),
    ].join("\n"));
    fs.writeFileSync(extFile, [
      JSON.stringify({ type: "session", id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", timestamp: "2026-09-01T00:00:00.000Z", cwd: HOME }),
      JSON.stringify({ type: "session_info", name: "小语 · 外部联系", timestamp: "2026-09-01T00:00:00.000Z" }),
      JSON.stringify({ type: "message", timestamp: "2026-09-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "在吗" }] } }),
    ].join("\n"));
    fs.writeFileSync(curFile, [
      JSON.stringify({ type: "session", id: "cccccccc-cccc-cccc-cccc-cccccccccccc", timestamp: "2026-09-01T00:00:00.000Z", cwd: HOME }),
      JSON.stringify({ type: "session_info", name: "subagent-worker-abc", timestamp: "2026-09-01T00:00:00.000Z" }),
      JSON.stringify({ type: "message", timestamp: "2026-09-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } }),
    ].join("\n"));

    assert.equal(parseSessionFile(workFile).group, "workspace");

    initSessionFiles({ sessionsDir: wsDir, workspaceCwd: WS });
    invalidateSessionCache();
    const listed = getSessionList();
    const byId = Object.fromEntries(listed.map(s => [s.id, s]));
    assert.equal(byId["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"].group, "workspace");
    assert.equal(byId["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"].group, "terminal");
    assert.equal(byId["cccccccc-cccc-cccc-cccc-cccccccccccc"].group, "foreign");
  } finally {
    invalidateSessionCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("微信桥会话单独成组，旧数据按名字前缀迁过来", () => {
  assert.equal(isListedGroup("wechat"), true);
  assert.equal(classifySessionGroup({ name: "微信·o9cq80wXRB4rZ", cwd: WS, group: "workspace", workspaceCwd: WS }), "wechat");
  assert.equal(classifySessionGroup({ name: "微信·o9cq80wXRB4rZ", cwd: WS, group: "terminal", workspaceCwd: WS }), "wechat");
  assert.equal(classifySessionGroup({ name: "微信·x", cwd: WS, group: "test", workspaceCwd: WS }), "test");
  assert.equal(classifySessionGroup({ name: "微信联系人 张三", cwd: HOME, workspaceCwd: WS }), "terminal");
});
