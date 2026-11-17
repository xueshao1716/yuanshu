// 执行员子代理（2026-11-18）：能写能跑，但每一轮有副作用的调用先停下等伙伴批准。
// 钉住：① 没批准之前一个字都不落盘；② 批准 / 全批 / 拒绝三条路；③ 批准也放不开的护栏；
// ④ 后台回执带批准卡，伙伴的原话经 continue 带回去，按决定落地后接着干。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJobPool } from "../../engine/job-pool.mjs";
import { createSubagentBackground } from "../../engine/subagent-background.mjs";
import { initSubagent, spawnSubagent, resolveToolPolicy } from "../../engine/subagent.mjs";
import { hardBlock, parseApproval, approvalCard, createWorkerExecutor } from "../../engine/subagent-worker.mjs";
import { DELEGATE_TASK_TOOL } from "../../engine/yuanshu-delegate.mjs";

const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const model = { provider: "fixture", id: "m", api: "openai-completions", maxTokens: 4000, contextWindow: 64000, baseUrl: "https://fixture.invalid/v1" };
const reply = (message, finish = "stop") => ({ ok: true, status: 200, json: async () => ({ model: "m", choices: [{ finish_reason: finish, message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) });
const final = (result) => reply({ content: JSON.stringify({ result, evidence: ["e"], confidence: 0.9 }) });

function fixtureModel(root, script) {
  const requests = [];
  initSubagent({ traceDir: path.join(root, "traces"), getFlashModel: () => model, getDefaultModel: () => model,
    authReader: () => ({ fixture: { key: "k" } }), modelReader: () => ({ fixture: { models: [model] } }),
    researchRoots: () => [root],
    httpFetch: async (_url, opts) => { const body = JSON.parse(opts.body); requests.push(body); return script(requests.length, body); },
  });
  return requests;
}

test("护栏：凭据、受保护文件、工作区外、危险命令——批准也放不开", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-guard-"));
  assert.match(hardBlock(call("a", "write", { path: ".token", content: "x" }), [root]), /不可写/);
  assert.match(hardBlock(call("a", "edit", { path: "记忆/人格定义.json", old: "a", new: "b" }), [root]), /受保护/);
  assert.match(hardBlock(call("a", "write", { path: path.join(os.tmpdir(), "outside.txt"), content: "x" }), [root]), /不可写/);
  assert.match(hardBlock(call("a", "bash", { command: "rm -rf build" }), [root]), /危险命令/);
  assert.match(hardBlock(call("a", "bash", { command: "cat auth.json" }), [root]), /凭据/);
  assert.match(hardBlock(call("a", "bash", { command: "git push --force" }), [root]), /红线/);
  assert.equal(hardBlock(call("a", "write", { path: "out/a.md", content: "x" }), [root]), "");
  assert.equal(hardBlock(call("a", "bash", { command: "node -v" }), [root]), "");
});

test("伙伴回话：批准这一步 / 这一轮都批准 / 拒绝；听不懂按拒绝（不替人点头）", () => {
  assert.equal(parseApproval("批准这一步"), "once");
  assert.equal(parseApproval("这一轮都批准"), "all");
  assert.equal(parseApproval("拒绝"), "reject");
  assert.equal(parseApproval("别改那个文件"), "reject");
  assert.equal(parseApproval("嗯？"), "reject");
  // 卡片点回来的整句：问题里的命令原文（--no-verify、取消）不能把「批准」带歪
  assert.equal(parseApproval("关于「子代理要跑命令 git commit --no-verify && 取消缓存」：我选「批准这一步」"), "once");
  assert.equal(parseApproval("关于「子代理要写文件 a.md」：跳过这个问题，你按自己的判断来"), "reject", "跳过不等于批准");
  assert.equal(parseApproval("关于「子代理要写文件 a.md」：可以，写吧"), "once");
  const card = approvalCard([call("w", "write", { path: "a.md", content: "hi" }), call("r", "read", { path: "x" })]);
  assert.match(card.question, /写文件 a\.md/);
  assert.doesNotMatch(card.question, /read/, "只读调用不上卡");
  assert.deepEqual(card.options, ["批准这一步", "这一轮都批准", "拒绝"]);
});

test("执行员真循环：要写文件 → 停下等批准、没落盘 → 批准后写入并接着干", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "worker-loop-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const requests = fixtureModel(root, (n) => n === 1
    ? reply({ content: "", tool_calls: [call("w1", "write", { path: "out/hello.md", content: "你好" })] }, "tool_calls")
    : final("写好了"));
  assert.equal(resolveToolPolicy("worker", { readTools: true }).kind, "worker");
  const checkpoints = [];
  const r = await spawnSubagent({ task: "写个文件", profile: "worker", askUser: true, onCheckpoint: (m) => checkpoints.push(m) });
  assert.equal(r.done, true, r.error);
  assert.equal(r.needsInput.kind, "approval");
  assert.match(r.needsInput.question, /写文件 out\/hello\.md/);
  assert.equal(fs.existsSync(path.join(root, "out/hello.md")), false, "没批准之前不能落盘");
  assert.ok(requests[0].tools.some((tool) => tool.function.name === "bash"));
  assert.ok(!checkpoints.at(-1)?.some((m) => m.tool_calls?.length), "存档里不留没执行的调用");

  const r2 = await spawnSubagent({ task: "写个文件", profile: "worker", askUser: true,
    resume: checkpoints.at(-1) || [], pendingRound: { message: r.needsInput.pending, decision: "once" } });
  assert.equal(r2.done, true, r2.error);
  assert.equal(r2.result, "写好了");
  assert.equal(fs.readFileSync(path.join(root, "out/hello.md"), "utf8"), "你好");
  const sent = requests.at(-1).messages;
  assert.ok(sent.some((m) => m.role === "tool" && m.tool_call_id === "w1" && /已新建/.test(m.content)), "执行结果要回给模型");
});

test("拒绝：不执行，回给模型明确的拒绝文本；全批之后同一轮的下一步不再停", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "worker-reject-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const held = { role: "assistant", content: "", tool_calls: [call("w1", "write", { path: "a.md", content: "x" })] };
  const requests = fixtureModel(root, () => final("改成只汇报"));
  const r = await spawnSubagent({ task: "t", profile: "worker", pendingRound: { message: held, decision: "reject", note: "先别动" } });
  assert.equal(r.done, true, r.error);
  assert.equal(fs.existsSync(path.join(root, "a.md")), false);
  assert.match(requests[0].messages.find((m) => m.tool_call_id === "w1").content, /拒绝.*先别动/);

  const root2 = await fsp.mkdtemp(path.join(os.tmpdir(), "worker-all-"));
  t.after(() => fsp.rm(root2, { recursive: true, force: true }));
  fixtureModel(root2, (n) => n === 1
    ? reply({ content: "", tool_calls: [call("w2", "write", { path: "b.md", content: "y" })] }, "tool_calls")
    : final("都写了"));
  const all = await spawnSubagent({ task: "t", profile: "worker", approveAll: true });
  assert.equal(all.needsInput, undefined);
  assert.equal(fs.readFileSync(path.join(root2, "b.md"), "utf8"), "y");
});

test("批准也放不开的调用不弹卡：直接回拒绝原因让它换做法", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "worker-hard-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const requests = fixtureModel(root, (n) => n === 1
    ? reply({ content: "", tool_calls: [call("t1", "write", { path: ".token", content: "x" })] }, "tool_calls")
    : final("改不了"));
  const r = await spawnSubagent({ task: "t", profile: "worker", askUser: true });
  assert.equal(r.needsInput, undefined);
  assert.equal(fs.existsSync(path.join(root, ".token")), false);
  assert.match(requests[1].messages.find((m) => m.tool_call_id === "t1").content, /不可写/);
});

test("edit / bash 执行器：CRLF 文件照样精确替换；bash 回退出码", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "worker-exec-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "c.txt"), "a\r\nb\r\nc\r\n");
  const exec = createWorkerExecutor({ roots: [root] });
  const ok = await exec("edit", { path: "c.txt", old: "a\nb", new: "a\nB" });
  assert.equal(ok.isError, undefined, ok.text);
  assert.equal(fs.readFileSync(path.join(root, "c.txt"), "utf8"), "a\r\nB\r\nc\r\n");
  assert.match((await exec("edit", { path: "c.txt", old: "zzz", new: "y" })).text, /找不到/);
  const out = await exec("bash", { command: "node -e \"console.log(1+1)\"" });
  assert.match(out.text, /退出码 0[\s\S]*2/);
});

test("后台执行员：回执带批准卡；伙伴的原话经 continue 带回，按决定落地", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-bg-"));
  const calls = [];
  const spawn = (params) => new Promise((resolve) => calls.push({ params, resolve }));
  const pool = createJobPool({ file: path.join(root, "jobs.json"), concurrency: 2 });
  const bg = createSubagentBackground({ wsRoot: root, pool, spawn });
  const started = bg.start({ task: "改配置", sessionId: "w1", profile: "worker" });
  const until = async (fn) => { for (let i = 0; i < 400; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); } throw new Error("timeout"); };
  const first = await until(() => calls[0]);
  assert.equal(first.params.profile, "worker");
  assert.equal(first.params.askUser, true);
  const held = { role: "assistant", content: "", tool_calls: [call("w1", "write", { path: "a.md", content: "x" })] };
  first.resolve({ done: true, result: "等你批准：子代理要写文件 a.md（1 字）", needsInput: { kind: "approval", question: "子代理要写文件 a.md（1 字）", options: ["批准这一步", "这一轮都批准", "拒绝"], pending: held } });
  await until(() => bg.get(started.subagentId).waitingInput);
  const note = bg.deliverReceipts({ agent: "w1" }).text;
  assert.match(note, /等你批准/);
  assert.match(note, /不要替伙伴批/);
  assert.match(note, /```dsh-ui\n\{"type":"choice","question":"子代理要写文件 a\.md（1 字）","options":\["批准这一步","这一轮都批准","拒绝"\]\}/);

  bg.continueSubagent({ subagentId: started.subagentId, message: "关于「子代理要写文件 a.md（1 字）」：我选「这一轮都批准」", sessionId: "w1" });
  const second = await until(() => calls[1]);
  assert.deepEqual(second.params.pendingRound, { message: held, decision: "all", note: "" });
  assert.equal(second.params.approveAll, true, "全批记在子代理上，之后的轮次也不再停");
  assert.equal(bg.get(started.subagentId).pendingRound, null);
});

test("delegate_task 工具：abilities 说清楚动手要弹卡；worker 留作旧写法", () => {
  const props = DELEGATE_TASK_TOOL.function.parameters.properties;
  assert.match(props.abilities.description, /批准/);
  assert.equal(props.worker.type, "boolean");
  assert.match(props.worker.description, /旧写法/);
});

// 2026-11-18：能力按活给——主智能体只勾需要的，子代理只拿到对应工具。
import { normalizeAbilities, needsHands, workerToolsFor } from "../../engine/subagent-worker.mjs";

test("能力清单：查总在；写文件 = write/edit，跑命令 = bash；别名与乱填都能处理", () => {
  assert.deepEqual(normalizeAbilities(["写文件"]), ["查", "写文件"]);
  assert.deepEqual(normalizeAbilities(["bash", "write", "瞎填"]), ["查", "写文件", "跑命令"]);
  assert.deepEqual(normalizeAbilities(undefined), ["查"]);
  assert.equal(needsHands(["查"]), false, "只查就还是只读研究员");
  assert.equal(needsHands(["跑命令"]), true);
  const names = (a) => workerToolsFor(a).map((t) => t.function.name);
  assert.deepEqual(names(["写文件"]).filter((n) => ["write", "edit", "bash"].includes(n)), ["write", "edit"]);
  assert.deepEqual(names(["跑命令"]).filter((n) => ["write", "edit", "bash"].includes(n)), ["bash"]);
  assert.equal(resolveToolPolicy("worker", { readTools: true, abilities: ["写文件"] }).toolNames.includes("bash"), false);
  assert.equal(resolveToolPolicy("worker", { readTools: true }).toolNames.includes("bash"), true, "不传 = 旧 worker:true，三样全给");
});

test("只给写文件：模型看不到 bash；硬调 bash 被挡住，不弹卡、不执行", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "worker-abilities-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const requests = fixtureModel(root, (n) => n === 1
    ? reply({ content: "", tool_calls: [call("b1", "bash", { command: "node -e \"require('fs').writeFileSync('x.txt','1')\"" })] }, "tool_calls")
    : final("没有跑命令的能力"));
  const r = await spawnSubagent({ task: "t", profile: "worker", askUser: true, abilities: ["写文件"], approveAll: true });
  assert.equal(r.done, true, r.error);
  assert.ok(!requests[0].tools.some((tool) => tool.function.name === "bash"), "工具表里就没有 bash");
  assert.match(requests[0].messages[0].content, /这次给你的能力：查、写文件/);
  assert.equal(fs.existsSync(path.join(root, "x.txt")), false);
  assert.match(requests[1].messages.find((m) => m.tool_call_id === "b1").content, /没给你「bash」/);
});

test("后台：能力在派活时定死，续上沿用；delegate_task 用 abilities 让主智能体按活给", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-bg-abilities-"));
  const calls = [];
  const spawn = (params) => new Promise((resolve) => calls.push({ params, resolve }));
  const pool = createJobPool({ file: path.join(root, "jobs.json"), concurrency: 2 });
  const bg = createSubagentBackground({ wsRoot: root, pool, spawn });
  const started = bg.start({ task: "改配置", sessionId: "a1", profile: "worker", abilities: ["写文件"] });
  const until = async (fn) => { for (let i = 0; i < 400; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); } throw new Error("timeout"); };
  const first = await until(() => calls[0]);
  assert.deepEqual(first.params.abilities, ["查", "写文件"]);
  first.resolve({ done: true, result: "好了" });
  await until(() => bg.get(started.subagentId).status === "done");
  bg.continueSubagent({ subagentId: started.subagentId, message: "再改一处", sessionId: "a1" });
  const second = await until(() => calls[1]);
  assert.deepEqual(second.params.abilities, ["查", "写文件"], "续上不会顺手加能力");

  const props = DELEGATE_TASK_TOOL.function.parameters.properties;
  assert.deepEqual(props.abilities.items.enum, ["查", "写文件", "跑命令"]);
  assert.match(props.abilities.description, /只勾需要的/);
});
