// 子代理可续（2026-11-17，学 Hermes 可恢复子代理 + deepagents 异步子代理）：
//   ① 每轮工具调用存一次进度；宿主重启后续上从进度接着干，而不是从头再来；
//   ② 开机自动续（有上限：每条最多 2 次、48 小时内、一次最多 4 条）；
//   ③ 跑到一半改需求：interrupt 打断带新指令重跑 / enqueue 跑完再接着做；
//   ④ 子代理要人拍板：ask_user → 回执里带一张 dsh-ui 选项卡，父会话原样贴给伙伴。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJobPool } from "../../engine/job-pool.mjs";
import { createSubagentBackground } from "../../engine/subagent-background.mjs";
import { readProgress, saveProgress, removeProgress, trimProgress } from "../../engine/subagent-progress.mjs";
import { initSubagent, spawnSubagent } from "../../engine/subagent.mjs";
import { DELEGATE_TASK_TOOL } from "../../engine/yuanshu-delegate.mjs";

function createFakeSpawn() {
  const calls = [];
  const spawn = (params) => new Promise((resolve) => {
    const call = { params, resolve };
    params.signal?.addEventListener?.("abort", () => resolve({ done: false, cancelled: true, errorCode: "cancelled", error: "子任务已取消" }), { once: true });
    calls.push(call);
  });
  return { calls, spawn };
}

async function until(check, { timeoutMs = 2000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function boot(root, extra = {}) {
  const pool = createJobPool({ file: path.join(root, `jobs-${Math.random()}.json`), concurrency: 2 });
  const fake = createFakeSpawn();
  const bg = createSubagentBackground({ wsRoot: root, pool, spawn: fake.spawn, ...extra });
  return { pool, fake, bg };
}

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "subagent-durable-"));
const toolRound = (id, text = "x") => [
  { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", tool_call_id: id, content: text },
];

test("进度存档：长内容截断、按轮丢最旧的、丢掉没回答完的尾轮（工具调用与结果不拆散）", () => {
  const rounds = [];
  for (let i = 0; i < 30; i++) rounds.push(...toolRound(`c${i}`, "y".repeat(9000)));
  rounds.push({ role: "assistant", content: null, tool_calls: [{ id: "dangling", type: "function", function: { name: "read", arguments: "{}" } }] });
  const kept = trimProgress(rounds, { maxMessages: 10 });
  assert.equal(kept.length, 10);
  assert.equal(kept[0].role, "assistant", "开头必须是一整轮的 assistant，不能是孤零零的 tool 结果");
  assert.equal(kept.at(-1).tool_call_id, "c29", "保留最新的");
  assert.ok(!kept.some((m) => m.tool_calls?.[0]?.id === "dangling"), "没回答完的尾轮要丢（续上时会重做）");
  assert.ok(kept.every((m) => !m.content || m.content.length <= 4000), "单条内容截断");

  const root = tmpRoot();
  const saved = saveProgress(root, "subagent-bg-x", toolRound("a"));
  assert.equal(saved.steps, 1);
  assert.equal(readProgress(root, "subagent-bg-x").length, 2);
  assert.deepEqual(readProgress(root, "../evil"), [], "id 不能拿来穿目录");
  removeProgress(root, "subagent-bg-x");
  assert.deepEqual(readProgress(root, "subagent-bg-x"), []);
});

test("重启续上：进度按轮存档 → 宿主重启 → 回执说可续 → 续聊从进度接着干，不从头来", async () => {
  const root = tmpRoot();
  const first = boot(root);
  const started = first.bg.start({ task: "调研 A", sessionId: "s1" });
  const call = await until(() => first.fake.calls[0]);
  assert.equal(typeof call.params.onCheckpoint, "function", "后台子代理必须带进度回调");
  call.params.onCheckpoint([...toolRound("c1", "查到 a"), ...toolRound("c2", "查到 b")]);
  // 宿主在这里"死了"：不 resolve，直接用同一个工作区重新起一个实例
  const second = boot(root);
  const record = second.bg.get(started.subagentId);
  assert.equal(record.status, "interrupted");
  assert.equal(record.progressSteps, 2);
  const note = second.bg.deliverReceipts({ agent: "s1" });
  assert.match(note.text, /进度已存档/);
  assert.match(note.text, new RegExp(`delegate_task.*action.*continue.*${started.subagentId}`), "提示里要写清楚怎么续，id 一字不差");
  assert.match(note.text, /副作用/);

  const out = second.bg.continueSubagent({ subagentId: started.subagentId, message: "接着干", sessionId: "s1" });
  assert.equal(out.ok, true, out.error);
  const resumed = await until(() => second.fake.calls[0]);
  assert.equal(resumed.params.task, "调研 A", "续上时任务还是原任务");
  assert.equal(resumed.params.resume.length, 5, "进度 4 条 + 一条续上说明");
  assert.match(resumed.params.resume.at(-1).content, /接着干/);
  resumed.resolve({ done: true, result: "做完了" });
  await until(() => second.bg.get(started.subagentId).status === "done");
  assert.deepEqual(readProgress(root, started.subagentId), [], "做完就清进度");
});

test("开机自动续：中断的子代理自己续上；每条有次数上限", async () => {
  const root = tmpRoot();
  const first = boot(root);
  const started = first.bg.start({ task: "调研 B", sessionId: "s2" });
  const call = await until(() => first.fake.calls[0]);
  call.params.onCheckpoint(toolRound("c1"));

  const autoResume = { enabled: true, delayMs: 0, maxPerRecord: 1 };
  const second = boot(root, { autoResume });
  assert.match(second.bg.deliverReceipts({ agent: "s2" }).text, /自动续/);
  const resumed = await until(() => second.fake.calls[0]);
  assert.equal(resumed.params.resume.length, 3);
  assert.match(resumed.params.resume.at(-1).content, /重启/);
  assert.equal(second.bg.get(started.subagentId).autoResumes, 1);

  // 续上之后又被重启打断：已经用完 1 次自动续，这次只留可续回执，不再自动跑
  const third = boot(root, { autoResume });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(third.fake.calls.length, 0, "超过上限不能无限自动重跑");
  assert.equal(third.bg.get(started.subagentId).status, "interrupted");
});

test("重启熔断：allow 返回 false 时不自动续，只留可手动续的回执", async () => {
  const root = tmpRoot();
  const first = boot(root);
  const started = first.bg.start({ task: "调研 C", sessionId: "s3" });
  const call = await until(() => first.fake.calls[0]);
  call.params.onCheckpoint(toolRound("c1"));

  const second = boot(root, { autoResume: { enabled: true, delayMs: 0, allow: () => false } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(second.fake.calls.length, 0, "熔断时不能再自动拉起");
  assert.equal(second.bg.get(started.subagentId).status, "interrupted");
  assert.doesNotMatch(second.bg.deliverReceipts({ agent: "s3" }).text, /自动续/);
});

test("改需求 enqueue：在跑时发的消息排队，跑完自动接着做", async () => {
  const root = tmpRoot();
  const { fake, bg } = boot(root);
  const started = bg.start({ task: "调研 C", sessionId: "s3" });
  const call = await until(() => fake.calls[0]);
  const out = bg.continueSubagent({ subagentId: started.subagentId, message: "顺便看下测试", sessionId: "s3" });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.strategy, "enqueue");
  call.resolve({ done: true, result: "C 的结论" });
  const next = await until(() => fake.calls[1]);
  assert.match(next.params.task, /顺便看下测试/);
  assert.equal(bg.get(started.subagentId).pendingMessages?.length || 0, 0);
});

test("改需求 interrupt：打断当前这轮，带着进度和新指令重跑；不发「已取消」回执", async () => {
  const root = tmpRoot();
  const { fake, bg } = boot(root);
  const started = bg.start({ task: "调研 D", sessionId: "s4" });
  const call = await until(() => fake.calls[0]);
  call.params.onCheckpoint(toolRound("c1", "查到一半"));
  const out = bg.continueSubagent({ subagentId: started.subagentId, message: "改用 Postgres", sessionId: "s4", strategy: "interrupt" });
  assert.equal(out.ok, true, out.error);
  const next = await until(() => fake.calls[1]);
  assert.equal(next.params.task, "调研 D");
  assert.match(next.params.resume.at(-1).content, /改用 Postgres/);
  assert.equal(next.params.resume.length, 3);
  assert.doesNotMatch(bg.deliverReceipts({ agent: "s4" }).text, /已取消/);
  assert.ok(bg.get(started.subagentId).history.some((h) => h.kind === "interrupted"));
});

test("要人拍板：needsInput → 回执带 dsh-ui 选项卡和续上方法；答案回来接着进度干", async () => {
  const root = tmpRoot();
  const { fake, bg } = boot(root);
  const started = bg.start({ task: "选数据库", sessionId: "s5" });
  const call = await until(() => fake.calls[0]);
  assert.equal(call.params.askUser, true);
  call.params.onCheckpoint(toolRound("c1"));
  call.resolve({ done: true, result: "需要你拍板：用哪个库？", needsInput: { question: "用哪个库？", options: ["Postgres", "SQLite"] } });
  await until(() => bg.get(started.subagentId).waitingInput);
  const note = bg.deliverReceipts({ agent: "s5" }).text;
  assert.match(note, /等你拍板/);
  assert.match(note, /```dsh-ui\n\{"type":"choice","question":"用哪个库？","options":\["Postgres","SQLite"\]\}\n```/);
  assert.match(note, new RegExp(`action.*continue.*${started.subagentId}`));

  bg.continueSubagent({ subagentId: started.subagentId, message: "关于「用哪个库？」：我选「SQLite」", sessionId: "s5" });
  const next = await until(() => fake.calls[1]);
  assert.equal(next.params.resume.length, 3, "拍板前的进度要带上");
  assert.match(next.params.resume.at(-1).content, /SQLite/);
  assert.equal(bg.get(started.subagentId).waitingInput, null);
});

test("研究员真循环：ask_user 被宿主截住 → needsInput；每轮工具后存进度；resume 接在任务后面", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "durable-research-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "a.txt"), "alpha\n");
  const model = { provider: "fixture", id: "m", api: "openai-completions", maxTokens: 4000, contextWindow: 64000, baseUrl: "https://fixture.invalid/v1" };
  const requests = [];
  const reply = (message, finish = "stop") => ({ ok: true, status: 200, json: async () => ({ model: "m", choices: [{ finish_reason: finish, message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) });
  initSubagent({ traceDir: path.join(root, "traces"), getFlashModel: () => model, getDefaultModel: () => model,
    authReader: () => ({ fixture: { key: "k" } }), modelReader: () => ({ fixture: { models: [model] } }),
    researchRoots: () => [root],
    httpFetch: async (url, opts) => {
      requests.push(JSON.parse(opts.body));
      if (requests.length === 1) return reply({ content: "", tool_calls: [{ id: "r1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } }] }, "tool_calls");
      return reply({ content: "", tool_calls: [{ id: "q1", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "要不要连 b 一起查？", options: ["要", "不要"] }) } }] }, "tool_calls");
    },
  });
  const checkpoints = [];
  const resume = [...toolRound("old", "之前查过的"), { role: "user", content: "（续上）" }];
  const r = await spawnSubagent({ task: "查 alpha", profile: "research", askUser: true, resume, onCheckpoint: (m) => checkpoints.push(m) });
  assert.equal(r.done, true, r.error);
  assert.deepEqual(r.needsInput, { question: "要不要连 b 一起查？", options: ["要", "不要"] });
  assert.ok(requests[0].tools.some((tool) => tool.function.name === "ask_user"));
  const firstMsgs = requests[0].messages;
  assert.equal(firstMsgs.at(-1).content, "（续上）", "resume 要接在任务之后");
  assert.ok(checkpoints.length >= 2);
  const last = checkpoints.at(-1);
  assert.ok(last.some((m) => m.tool_call_id === "r1"), "存档里有这次查到的");
  assert.equal(last.at(-1).role, "assistant");
  assert.match(last.at(-1).content, /要不要连 b 一起查/, "最后一条记下它问了什么，续上时直接接答案");
  assert.ok(!last.some((m) => m.tool_calls?.some((c) => c.id === "q1")), "不留没回答的 ask_user 调用");
});

test("delegate_task 工具：能 start/continue/list/cancel，改需求能选 interrupt/enqueue", () => {
  const props = DELEGATE_TASK_TOOL.function.parameters.properties;
  assert.deepEqual(props.action.enum, ["start", "continue", "list", "cancel"]);
  assert.ok(props.subagent_id && props.message);
  assert.deepEqual(props.strategy.enum, ["interrupt", "enqueue"]);
  assert.deepEqual(DELEGATE_TASK_TOOL.function.parameters.required || [], [], "continue/list 不需要 task");
});
