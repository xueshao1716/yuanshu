// 元枢评测集：只量可观察行为，不跑真模型，不扫源码当分数。
import {
  isEmptyAssistantTurn, emptyTurnDecision, inspectToolCalls,
} from "./yuanshu-stability.mjs";
import { recordStuckEvent, detectStuck } from "./yuanshu-stuck.mjs";
import { matchSkillsForTask, buildYuanshuContext, coachToolFailure, YUANSHU_PROTOCOL } from "./yuanshu-protocol.mjs";
import { sessionContinuityNote, coachSearchRound, abortedAssistantText, persistYuanshuUser } from "./yuanshu-session.mjs";
import { runYuanshuToolRound } from "./yuanshu-loop.mjs";
import { beginYuanshuEmotion, endYuanshuEmotion } from "./yuanshu-emotion.mjs";
import { clearEmotion } from "./emotion.mjs";

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

export const YUANSHU_EVAL_CASES = [
  { id: "empty-turn-empty", tag: "stability", run: async () => {
    ok(isEmptyAssistantTurn({ text: "", hasTools: false }) === true, "空正文无工具应判空");
    ok(isEmptyAssistantTurn({ text: "你好", hasTools: false }) === false, "有正文不该空");
    ok(isEmptyAssistantTurn({ text: "", hasTools: true }) === false, "有工具不该空");
  } },
  { id: "empty-turn-bound", tag: "stability", run: async () => {
    ok(emptyTurnDecision(2) === "retry", "第2次空应重试");
    ok(emptyTurnDecision(3) === "exhausted", "第3次空应耗尽");
  } },
  { id: "truncated-tool-json", tag: "stability", run: async () => {
    const r = inspectToolCalls([{ id: "1", function: { name: "write", arguments: '{"path":"a","content":"<div' } }]);
    ok(r.truncated === true && r.calls.length === 0, "半截 JSON 必须停");
  } },
  { id: "truncated-missing-name", tag: "stability", run: async () => {
    ok(inspectToolCalls([{ id: "1", function: { arguments: "{}" } }]).truncated === true, "缺 name 算截断");
  } },
  { id: "legal-tool-pass", tag: "stability", run: async () => {
    const r = inspectToolCalls([{ id: "1", function: { name: "read", arguments: '{"path":"a.txt"}' } }]);
    ok(r.truncated === false && r.calls[0].function.name === "read", "合法调用必须放行");
  } },
  { id: "stuck-repeat", tag: "tools", run: async () => {
    const ev = [];
    for (let i = 0; i < 4; i++) ev.push(recordStuckEvent("read", { path: "a.md" }, { text: "hello" }));
    ok(/循环|重复/.test(detectStuck(ev)?.hint || ""), "同一动作 4 次要判卡住");
  } },
  { id: "stuck-single-ok", tag: "tools", run: async () => {
    ok(detectStuck([recordStuckEvent("read", { path: "x" }, { text: "ok" })]) === null, "一次 read 不该误杀");
  } },
  { id: "tool-round-loop-stop", tag: "tools", run: async () => {
    const history = [];
    const stuckEvents = [];
    let stop = null;
    for (let i = 0; i < 4; i++) {
      const r = await runYuanshuToolRound({
        toolCalls: [{ id: String(i), type: "function", function: { name: "read", arguments: "{\"path\":\"a.md\"}" } }],
        history, stuckEvents,
        execute: async () => ({ text: "hello", isError: false }),
        policyDecide: () => ({ decision: "allow" }),
        jitForPath: () => [],
      });
      if (r.stop) { stop = r.stop; break; }
    }
    ok(stop && /循环|重复|卡住/.test(String(stop.error || "")), "工具轮重复必须停");
  } },
  { id: "search-coach", tag: "tools", run: async () => {
    const one = coachSearchRound("web_search", 1, { text: "a" });
    const two = coachSearchRound("web_search", 2, { text: "b" });
    ok(!/不要再连搜/.test(one.text), "一轮搜索不该骂");
    ok(/不要再连搜|按判断写/.test(two.text), "两轮搜索要收口");
  } },
  { id: "skill-video-hit", tag: "protocol", run: async () => {
    const skills = [
      { name: "aigc-video-production", desc: "视频创作流水线" },
      { name: "wanxiang-portrait", desc: "人物写真" },
    ];
    ok(matchSkillsForTask("做个视频", skills).some((s) => s.name === "aigc-video-production"), "视频任务要命中视频技能");
    ok(matchSkillsForTask("嗯", skills).length === 0, "嗯不该配技能");
  } },
  { id: "protocol-host-tools", tag: "protocol", run: async () => {
    ok(/generate_video/.test(YUANSHU_PROTOCOL) && /密钥/.test(YUANSHU_PROTOCOL), "协议要点名宿主工具和密钥");
  } },
  { id: "protocol-context", tag: "protocol", run: async () => {
    const ctx = buildYuanshuContext({ message: "做个视频", skills: [{ name: "aigc-video-production", desc: "视频" }], hist: [{ role: "user" }] });
    ok(ctx.some((s) => /activate_skill/.test(s) && /aigc-video-production/.test(s)), "上下文要带匹配技能");
    ok(ctx.some((s) => /不是新开的/.test(s)), "有历史不能装新开");
  } },
  { id: "continuity-first", tag: "memory", run: async () => {
    ok(/记忆\.md|不要 bash/.test(sessionContinuityNote([])), "首轮要点记忆目录，禁止扫盘");
  } },
  { id: "continuity-resume", tag: "memory", run: async () => {
    ok(/不是新开的/.test(sessionContinuityNote([{ role: "user" }])), "有历史必须接着做");
  } },
  { id: "abort-leave-mark", tag: "memory", run: async () => {
    ok(abortedAssistantText({ text: "" }) === "（本轮已停止）", "打断无正文要留停止标记");
    ok(abortedAssistantText({ text: "半句" }) === "半句", "打断有正文要留下");
  } },
  { id: "persist-user", tag: "memory", run: async () => {
    const got = [];
    persistYuanshuUser({ appendMessage: (m) => got.push(m) }, "韩跑跑是谁");
    ok(got[0]?.content?.[0]?.text === "韩跑跑是谁", "用户原话必须先落盘");
  } },
  { id: "coach-video-fail", tag: "protocol", run: async () => {
    const r = coachToolFailure("generate_video", {}, { text: "缺 mode", isError: true });
    ok(/接着|判断|汇报/.test(r.text), "出片失败要给宿主下一步");
  } },
  { id: "prompt-seams", tag: "protocol", run: async () => {
    const { PluginRegistry } = await import("./plugin-registry.mjs");
    const { registerPromptSection, assembleYuanshuSystem } = await import("./yuanshu-seams.mjs");
    const { assemblePrompt } = await import("./yuanshu-prompt.mjs");
    const reg = new PluginRegistry();
    await registerPromptSection(reg, { id: "yuanshu:prompt:time", section: "time", contribute: () => "接缝时间" });
    const blob = assemblePrompt(assembleYuanshuSystem({ message: "嗯" }, reg, {}));
    ok(/section:protocol/.test(blob) && /接缝时间/.test(blob), "协议来自宿主，时间来自接缝");
  } },
  { id: "workmem-disk", tag: "memory", run: async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { initYuanshuWorkmem, writePlanFile, formatPlanPrompt } = await import("./yuanshu-workmem.mjs");
    const root = mkdtempSync(join(tmpdir(), "ys-eval-wm-"));
    initYuanshuWorkmem(root);
    writePlanFile("e1", "task_plan", "- [ ] 阶段一");
    const blob = formatPlanPrompt("e1", { message: "嗯" });
    ok(/task_plan/.test(blob) && /阶段一/.test(blob), "有磁盘计划必须开轮注入");
    ok(formatPlanPrompt("none", { message: "嗯" }) === "", "闲聊无文件不灌");
    rmSync(root, { recursive: true, force: true });
  } },
  { id: "prompt-sections", tag: "protocol", run: async () => {
    const { assemblePrompt, buildYuanshuSections } = await import("./yuanshu-prompt.mjs");
    const blob = assemblePrompt(buildYuanshuSections({ message: "嗯", persona: "小语", time: "此刻" }));
    ok(/section:protocol/.test(blob) && /section:persona/.test(blob), "system 必须按命名区段拼");
  } },
  { id: "sandbox-readonly-write", tag: "tools", run: async () => {
    const { checkSandboxCall, sandboxDeniedTag } = await import("./yuanshu-sandbox.mjs");
    const r = checkSandboxCall({ mode: "read-only", name: "write", args: { path: "a.md" } });
    ok(r.ok === false && r.tag === sandboxDeniedTag("read-only"), "read-only 必须拦写");
  } },
  { id: "compact-keep-archive", tag: "memory", run: async () => {
    const { compactViewFromSummary } = await import("./yuanshu-compact.mjs");
    const hist = [{ role: "user", content: "旧" }, { role: "user", content: "新" }];
    const r = compactViewFromSummary(hist, "摘要", { keep: 1 });
    ok(r.archive[0].content === "旧" && /摘要/.test(r.view[0].content), "压缩不能丢原文");
  } },
  { id: "emotion-roundtrip", tag: "memory", run: async () => {
    const key = "eval-emo-roundtrip";
    clearEmotion(key);
    const hist = beginYuanshuEmotion(key, "我好烦，又坏了", []);
    ok(hist.some((m) => /情绪语境/.test(m.content || "")), "开轮必须注入情绪语境");
    const ev = [];
    endYuanshuEmotion(key, "我好烦，又坏了", "先改这一处。", { push: (t, d) => ev.push({ t, d }) });
    ok(ev[0]?.t === "emotion" && ev[0]?.d?.state, "收轮必须推 emotion");
  } },
  { id: "mem-route-topk", tag: "memory", run: async () => {
    const { routeMemory, MEMORY_TOP_K } = await import("./yuanshu-memroute.mjs");
    ok(MEMORY_TOP_K === 5, "预算必须是 5");
    const picked = routeMemory({
      query: "下周面试怎么办",
      entities: ["面试"],
      candidates: [
        { source: "log", text: "面试准备了两个月" },
        { source: "log", text: "去云南旅游买了机票" },
        { source: "relation", text: "重要场合前容易焦虑" },
        { source: "correction", text: "面试别说加油打气" },
        { source: "log", text: "晚饭吃了面" },
        { source: "log", text: "修了 8787 端口" },
        { source: "log", text: "面试官姓王" },
        { source: "log", text: "又一次面试复盘" },
      ],
    });
    ok(picked.length <= 5, "最多灌 5 条");
    ok(picked.some((t) => /面试/.test(t)), "面试相关必须在");
    ok(!picked.some((t) => /云南旅游/.test(t)), "无关旅游不得挤进 Top-5");
  } },
];
