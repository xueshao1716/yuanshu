// 定时任务双模式决策树 + 静默失败检测（2026-11-09，来源 xinyu-hermes 教训）
//
// 钉住五件事：
//   ① classifyJob：固定产出→deterministic；要判断→needs-judgement；说不清按 needs-judgement；
//   ② planJob：needs-judgement 第一步必须是确定性采集（并列出证据），第二步才 LLM；
//      deterministic 却检测到会调模型 → violation；
//   ③ 审计名单是真的（31 条真实定时任务），deterministic 的条目一个模型调用都没有；
//   ④ 连续 3 次没有产出 → 写 记忆/运行时/定时任务告警.jsonl，30 分钟冷却，出一次产出就清零；
//   ⑤ 告警出现在 GET /api/degradation 的 reasons / scheduled 里，并真被 server 挂上心跳。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  POLICY, JOB_KIND, FIXED_OUTPUTS, JUDGEMENT_TASKS, SILENT_FAILURE,
  RUN_LOG_REL, ALERT_LOG_REL,
  classifyJob, classifyReason, planJob, modelCallsOf, planEvidence,
  auditJobs, JOB_INVENTORY,
  detectSilentFailures, recordJobRun, readScheduledHealth,
} from "../../engine/scheduled-policy.mjs";
import { degradationSnapshot } from "../../engine/degradation.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const NOW = new Date(2026, 10, 9, 21, 0, 0, 0).getTime();
const MIN = 60 * 1000;
const jsonl = (root, rel) => {
  try { return fs.readFileSync(path.join(root, rel), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

// ───────────── 一、classifyJob ─────────────

test("classify：固定产出 → deterministic（检查/清理/归档/统计/快照/索引…）", () => {
  for (const output of FIXED_OUTPUTS) {
    assert.equal(classifyJob({ id: `x-${output}`, output }), JOB_KIND.DETERMINISTIC, `${output} 应该是脚本活`);
  }
  assert.equal(classifyJob({ id: "a", task: "cleanup" }), JOB_KIND.DETERMINISTIC);
  assert.equal(classifyJob({ id: "b", deterministic: true }), JOB_KIND.DETERMINISTIC);
  assert.equal(classifyJob({ id: "c", fixed: true }), JOB_KIND.DETERMINISTIC);
  assert.equal(classifyJob({ id: "d", output: "archive" }), "deterministic");
  assert.match(classifyReason({ output: "cleanup" }), /固定产出/);
});

test("classify：要判断 → needs-judgement（写文案/决定是否打扰/诊断）", () => {
  for (const output of JUDGEMENT_TASKS) {
    assert.equal(classifyJob({ id: `x-${output}`, output }), JOB_KIND.NEEDS_JUDGEMENT, `${output} 要判断`);
  }
  assert.equal(classifyJob({ id: "a", judgement: ["写一句汇报"] }), JOB_KIND.NEEDS_JUDGEMENT);
  assert.equal(classifyJob({ id: "b", needsJudgement: true }), JOB_KIND.NEEDS_JUDGEMENT);
  // 声明了要判断，就不能用 fixed 把它洗成脚本
  assert.equal(classifyJob({ id: "c", fixed: true, judgement: ["措辞"] }), JOB_KIND.NEEDS_JUDGEMENT);
  // 判不出来 → 保守按 needs-judgement（宁可多一步采集）
  assert.equal(classifyJob({ id: "d" }), JOB_KIND.NEEDS_JUDGEMENT);
  assert.equal(classifyJob({}), JOB_KIND.NEEDS_JUDGEMENT);
  assert.equal(classifyJob(null), JOB_KIND.NEEDS_JUDGEMENT);
  assert.match(classifyReason({}), /说不清|保守/);
});

test("POLICY 是规范本体：六条规则都在，阈值可被测试钉住", () => {
  assert.equal(POLICY.version, 1);
  assert.equal(POLICY.rules.length, 6);
  assert.ok(POLICY.rules.some((r) => /deterministic/.test(r) && /不许调/.test(r)));
  assert.ok(POLICY.rules.some((r) => /第一步必须是确定性采集/.test(r)));
  assert.ok(POLICY.rules.some((r) => /violation/.test(r)));
  assert.equal(SILENT_FAILURE.threshold, 3);
  assert.equal(SILENT_FAILURE.cooldownMs, 30 * MIN);
});

// ───────────── 二、planJob：两步顺序与违规 ─────────────

test("planJob：needs-judgement 必须两步——先确定性采集（带证据清单），再 LLM", () => {
  const job = {
    id: "morning-brief", judgement: ["早上那段话怎么说"],
    evidence: [
      { source: "记忆/运行时/待办.json", what: "还剩几件" },
      { source: "会话列表", what: "昨天动过几个会话" },
    ],
    modelCalls: ["composeNotice"],
  };
  const plan = planJob(job);
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, JOB_KIND.NEEDS_JUDGEMENT);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].step, 1);
  assert.equal(plan.steps[0].mode, "deterministic", "第一步不许是模型");
  assert.equal(plan.steps[0].action, "collect");
  assert.equal(plan.steps[0].collect.length, 2, "要列出给它哪些证据");
  assert.equal(plan.steps[0].collect[0].source, "记忆/运行时/待办.json");
  assert.equal(plan.steps[0].collect[0].what, "还剩几件");
  assert.equal(plan.steps[1].step, 2);
  assert.equal(plan.steps[1].mode, "llm");
  assert.deepEqual(plan.steps[1].modelCalls, ["composeNotice"]);
  // 顺序是硬约束：先确定性、后 LLM
  assert.ok(plan.steps.findIndex((s) => s.mode === "llm") > plan.steps.findIndex((s) => s.mode === "deterministic"));
  // 证据也可以由调用方给
  const fromCtx = planJob({ id: "nudge", judgement: ["要不要打扰"] }, { evidence: ["主动预算.json"] });
  assert.equal(fromCtx.ok, true);
  assert.equal(fromCtx.steps[0].collect[0].source, "主动预算.json");
  assert.deepEqual(planEvidence({}, {}), []);
});

test("planJob：要判断却拿不出证据清单 → blocked（空着手问模型等于让它编）", () => {
  const plan = planJob({ id: "vibes", judgement: ["凭感觉"] });
  assert.equal(plan.ok, false);
  assert.equal(plan.blocked.code, "no-evidence-planned");
  assert.equal(plan.violation, undefined);
  assert.equal(plan.steps[0].collect.length, 0);
});

test("planJob：deterministic 却会调模型 → violation（Hermes 烧 6000 万 token 那条路）", () => {
  // 一个"清理"作业被写成每轮都调模型
  const bad = planJob({ id: "cache-cleanup", output: "cleanup", modelCalls: ["directChat"] });
  assert.equal(bad.ok, false);
  assert.equal(bad.violation.code, "deterministic-calls-model");
  assert.deepEqual(bad.violation.modelCalls, ["directChat"]);
  assert.match(bad.violation.message, /Hermes|6000 万|模型/);
  assert.equal(bad.steps.length, 1, "违规时也给出它本该走的单步脚本计划");
  assert.equal(bad.steps[0].mode, "deterministic");

  // 干净的脚本作业：ok
  const good = planJob({ id: "cache-cleanup", output: "cleanup" });
  assert.equal(good.ok, true);
  assert.equal(good.violation, undefined);
  assert.equal(good.steps[0].action, "run");
  assert.equal(good.steps.length, 1);

  // ctx 里带出来的模型调用同样算违规
  assert.equal(planJob({ id: "x", output: "archive" }, { modelCalls: ["writeShortNotice"] }).violation.code, "deterministic-calls-model");
  assert.equal(modelCallsOf({ modelCalls: ["a"] }, { modelCalls: ["a", "b"] }).length, 2);
});

// ───────────── 三、真实名单审计 ─────────────

test("审计：32 条真实定时任务，23 条其实不需要模型，0 条违规", () => {
  const audit = auditJobs();
  assert.equal(audit.total, JOB_INVENTORY.length);
  assert.equal(audit.total, 32);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.violations, []);
  assert.equal(audit.deterministicCount, 23);
  assert.equal(audit.needsJudgementCount, 9);

  // 名单去重、每条都有出处
  const ids = JOB_INVENTORY.map((j) => j.id);
  assert.equal(new Set(ids).size, ids.length, "作业 id 不许重复");
  for (const job of JOB_INVENTORY) {
    assert.ok(job.id, "每条都要有 id");
    assert.ok(job.where, `${job.id} 要写出处（哪个文件/哪一段）`);
    assert.ok(job.every, `${job.id} 要写节拍`);
  }

  // deterministic 的条目一个模型调用都不许有；needs-judgement 必须能给出两步计划
  for (const row of audit.rows) {
    if (row.kind === JOB_KIND.DETERMINISTIC) {
      assert.deepEqual(row.modelCalls, [], `${row.id} 被判成脚本活却说会调模型`);
    } else {
      assert.equal(row.ok, true, `${row.id} 要判断，但计划不完整`);
    }
  }

  // "哪些其实不需要模型"里必须有这几个真名字
  for (const id of ["watch-duty", "time-engine-tick", "proactive-sweep", "memory-hygiene", "recall-rebuild", "degradation-auto", "forget-cycle", "watchdog-monitor"]) {
    assert.ok(audit.noModelNeeded.includes(id), `${id} 不该烧 token`);
  }
  // 真要模型的也要老实列出来
  for (const id of ["scheduler-briefs", "companion-nudge", "time-engine-task", "promise-sweep"]) {
    assert.ok(audit.needsJudgement.includes(id), `${id} 确实要判断`);
  }
  // 三分之二以上是脚本活——这就是 Hermes 教训的价值
  assert.ok(audit.deterministicCount > audit.needsJudgementCount * 2);
});

test("审计：名单与 classify 同源（改名单不能绕过规则）", () => {
  const audit = auditJobs([
    { id: "a", output: "stats" },
    { id: "b", output: "write", evidence: ["x"] },
    { id: "c", output: "cleanup", modelCalls: ["directChat"] },
  ]);
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.violations.map((v) => v.jobId), ["c"]);
  // c 按产出性质仍是"脚本活"（所以进 noModelNeeded），但它违规调了模型——两件事分开记
  assert.deepEqual(audit.noModelNeeded.slice().sort(), ["a", "c"]);
  assert.deepEqual(audit.needsJudgement, ["b"]);
});

// ───────────── 四、静默失败：连续 3 次没有产出 ─────────────

test("detectSilentFailures：连续 3 次没产出才告警；中间成功一次就清零", () => {
  const at = (i) => NOW + i * 1000;
  assert.deepEqual(detectSilentFailures([{ jobId: "a", at: at(0), produced: false }, { jobId: "a", at: at(1), produced: false }]), [],
    "两次不够，不许狼来了");
  const hit = detectSilentFailures([
    { jobId: "a", at: at(0), produced: false },
    { jobId: "a", at: at(1), produced: false },
    { jobId: "a", at: at(2), produced: false },
  ]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].jobId, "a");
  assert.equal(hit[0].streak, 3);
  assert.equal(hit[0].since, at(0));
  assert.equal(hit[0].lastAt, at(2));
  assert.equal(hit[0].code, "silent-failure");

  // 成功一次就清零（那是抖，不是死）
  assert.deepEqual(detectSilentFailures([
    { jobId: "a", at: at(0), produced: false },
    { jobId: "a", at: at(1), produced: false },
    { jobId: "a", at: at(2), produced: true },
    { jobId: "a", at: at(3), produced: false },
  ]), []);

  // 多作业互不影响；顺序打乱也要按时间算
  const multi = detectSilentFailures([
    { jobId: "b", at: at(2), produced: false },
    { jobId: "a", at: at(0), produced: false },
    { jobId: "a", at: at(3), produced: false },
    { jobId: "b", at: at(1), produced: false },
    { jobId: "a", at: at(1), produced: false },
    { jobId: "b", at: at(4), produced: false },
  ]);
  assert.deepEqual(multi.map((x) => x.jobId).sort(), ["a", "b"]);
  assert.equal(multi.find((x) => x.jobId === "a").streak, 3);
  // 自定义阈值
  assert.equal(detectSilentFailures([{ jobId: "c", at: at(0), produced: false }], { threshold: 1 }).length, 1);
});

test("recordJobRun：第 3 次没产出落告警；30 分钟冷却；出一次产出就清零", () => {
  const root = ws();
  assert.deepEqual(jsonl(root, ALERT_LOG_REL), [], "还没有告警文件");

  const r1 = recordJobRun(root, { jobId: "flaky", at: NOW, produced: false, note: "抛异常" });
  assert.equal(r1.ok, true);
  assert.equal(r1.streak, 1, "第一次没产出只记数，不告警");
  assert.equal(r1.alerted, false);
  assert.equal(jsonl(root, RUN_LOG_REL).length, 1, "每一拍都要留心跳");

  const r2 = recordJobRun(root, { jobId: "flaky", at: NOW + MIN, produced: false });
  assert.equal(r2.streak, 2);
  assert.deepEqual(jsonl(root, ALERT_LOG_REL), [], "两次还不够");

  const r3 = recordJobRun(root, { jobId: "flaky", at: NOW + 2 * MIN, produced: false });
  assert.equal(r3.streak, 3);
  assert.equal(r3.alerted, true);
  const alerts = jsonl(root, ALERT_LOG_REL);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].jobId, "flaky");
  assert.equal(alerts[0].code, "silent-failure");
  assert.equal(alerts[0].streak, 3);
  assert.equal(alerts[0].since, NOW);
  assert.match(alerts[0].message, /flaky.*连续 3 次没有产出/);
  assert.ok(fs.existsSync(path.join(root, "记忆", "运行时", "定时任务告警.jsonl")), "告警落盘位置是约定路径");

  // 还在冷却里：第 4、5 次没产出也不重复告警
  const r4 = recordJobRun(root, { jobId: "flaky", at: NOW + 3 * MIN, produced: false });
  assert.equal(r4.alerted, false);
  assert.equal(r4.cooled, true);
  assert.equal(jsonl(root, ALERT_LOG_REL).length, 1);

  // 出一次产出 → 清零
  const r5 = recordJobRun(root, { jobId: "flaky", at: NOW + 4 * MIN, produced: true });
  assert.equal(r5.streak, 0);
  const r6 = recordJobRun(root, { jobId: "flaky", at: NOW + 5 * MIN, produced: false });
  assert.equal(r6.streak, 1, "清零之后重新数");
  assert.equal(r6.alerted, false);

  // 参数不全不炸
  assert.equal(recordJobRun("", { jobId: "x" }).ok, false);
  assert.equal(recordJobRun(root, {}).ok, false);
});

test("readScheduledHealth：给出作业表/静默清单/人话 reasons，空工作区不编", () => {
  const root = ws();
  const empty = readScheduledHealth(root, { now: NOW });
  assert.deepEqual(empty.jobs, []);
  assert.deepEqual(empty.alerts, []);
  assert.deepEqual(empty.reasons, []);

  for (let i = 0; i < 3; i += 1) recordJobRun(root, { jobId: "silent-one", at: NOW + i * MIN, produced: false });
  recordJobRun(root, { jobId: "healthy-one", at: NOW + MIN, produced: true });

  const h = readScheduledHealth(root, { now: NOW + 5 * MIN });
  assert.equal(h.jobs.length, 2);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.silent.length, 1);
  assert.equal(h.silent[0].jobId, "silent-one");
  assert.equal(h.silent[0].streak, 3);
  assert.match(h.reasons[0], /定时任务「silent-one」连续 3 次没有产出/);
  // 24 小时窗外的旧心跳不算数
  const old = readScheduledHealth(root, { now: NOW + 48 * 60 * MIN });
  assert.equal(old.alerts.length, 0);
});

// ───────────── 五、与健康看板呼应 ─────────────

test("告警出现在 GET /api/degradation：reasons 有话说、scheduled 有明细", () => {
  const root = ws();
  for (let i = 0; i < 3; i += 1) recordJobRun(root, { jobId: "nudge", at: NOW + i * MIN, produced: false, note: "静默被挡" });

  const snap = degradationSnapshot(root, { now: NOW + 5 * MIN });
  assert.equal(snap.ok, true);
  assert.ok(snap.assessment.reasons.some((r) => /定时任务「nudge」连续 3 次没有产出/.test(r)),
    "退化看板的 reasons 里要能看到它");
  assert.ok(snap.scheduled, "快照要带 scheduled 明细");
  assert.equal(snap.scheduled.alerts.length, 1);
  assert.equal(snap.scheduled.alerts[0].jobId, "nudge");
  assert.deepEqual(snap.scheduled.silent.map((x) => x.jobId), ["nudge"]);
  assert.equal(snap.scheduled.jobs, 1);
  // 不加维度、不改算式：五维照旧，告警只是多一条理由
  assert.equal(snap.assessment.evaluated.length + snap.assessment.unevaluated.length, 5);
});

// ───────────── 六、静态断言 ─────────────

test("接线：server 的 10 分钟循环会记 degradation-auto 心跳；degradation 读本模块的告警", () => {
  const server = read("server.mjs");
  assert.match(server, /import \{ recordJobRun \} from "\.\/engine\/scheduled-policy\.mjs"/);
  assert.match(server, /recordJobRun\(WS_ROOT, \{\s*jobId: "degradation-auto"/);
  assert.match(server, /produced: deg\?\.ok === true/, "成功/失败要如实上报，不能永远 true");

  const deg = read("engine/degradation.mjs");
  assert.match(deg, /import \{ readScheduledHealth \} from "\.\/scheduled-policy\.mjs"/);
  assert.match(deg, /out\.reasons\.push\(\.\.\.scheduled\.reasons\)/, "告警必须并进 reasons");
  assert.match(deg, /scheduled: assessment\.scheduled/, "快照要把 scheduled 带出去");

  // 单向依赖：scheduled-policy 不许 import degradation（否则成环）
  const policy = read("engine/scheduled-policy.mjs");
  assert.ok(!/from "\.\/degradation\.mjs"/.test(policy), "scheduled-policy 不能反过来依赖 degradation");
});
