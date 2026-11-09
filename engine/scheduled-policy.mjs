// ===== scheduled-policy.mjs —— 定时任务双模式决策树（2026-11-09）=====
//
// 病灶来自 xinyu-hermes 的教训：cron 全用 LLM 跑，一天烧 6000 万 token，
// 而且失败还被静默吞掉——**花钱买不到结论，坏了也没人知道**。
//
// 元枢有二十多个定时任务（10 分钟循环、5 分钟 nudge、watch、time-engine、清理/归档/快照…），
// 其中真正"要判断"的是少数；固定的检查/清理/归档/统计根本不需要模型。
//
// 所以本文件只做三件事（全是纯函数，不读盘、不调模型、不看系统时钟）：
//   ① classifyJob(job)  → 'deterministic' | 'needs-judgement'
//   ② planJob(job, ctx) → 执行计划：needs-judgement 的第一必须是确定性采集，第二才允许 LLM；
//                         deterministic 却声明/检测到会调模型 → violation
//   ③ 静默失败检测：detectSilentFailures(records) 连续 N 次没有产出 → 告警；
//                    recordJobRun 落 定时任务心跳.jsonl / 定时任务告警.jsonl
//
// 与 degradation 的关系：degradation.mjs 读本文件的 readScheduledHealth 把告警并进
// GET /api/degradation 的 reasons（单向依赖，本文件不 import degradation，避免循环）。
//
// 纪律：判断"这一拍该不该动手"可以便宜，判断"这话该怎么说"才贵。
//       便宜的那半永远是脚本；贵的那半必须先把证据摆到桌上（planJob 的 step 1）。

import fs from "node:fs";
import path from "node:path";

// ── 一、规范（代码常量；文档见 docs/2026-11-09-scheduled-two-modes.md）────────
export const JOB_KIND = Object.freeze({
  DETERMINISTIC: "deterministic",
  NEEDS_JUDGEMENT: "needs-judgement",
});

/** 规范本体。改规则先改这里，再改文档，再改测试。 */
export const POLICY = Object.freeze({
  version: 1,
  title: "定时任务双模式：固定产出走脚本，要判断的先采集再问模型",
  source: "xinyu-hermes：cron 全用 LLM，一天 6000 万 token，还全被静默挡下",
  rules: Object.freeze([
    "① 固定产出（检查健康/清理/归档/统计/快照/索引/同步/提醒/心跳）→ deterministic：纯脚本，一次模型都不许调。",
    "② 要判断（写文案/决定是否打扰/诊断/取舍/排序/提炼）→ needs-judgement。",
    "③ needs-judgement 的第一步必须是确定性采集脚本，并列出要喂给模型的证据；第二步才允许调模型（planJob 钉住顺序）。",
    "④ deterministic 作业一旦被检测到会调模型 → violation，必须停下改回脚本，不许\"先跑着\"。",
    "⑤ 判不出来时按 needs-judgement 处理——宁可多一步采集，也不许悄悄烧 token。",
    "⑥ 任何定时任务连续 3 次没有产出 → 记 定时任务告警.jsonl，并出现在 /api/degradation 的 reasons 里。",
  ]),
});

/** 固定产出：出现这些 output/task 就判 deterministic。 */
export const FIXED_OUTPUTS = Object.freeze([
  "health-check", "cleanup", "archive", "stats", "snapshot",
  "index", "sync", "sweep", "reminder", "heartbeat", "audit",
]);

/** 要判断：出现这些 output/task 就判 needs-judgement。 */
export const JUDGEMENT_TASKS = Object.freeze([
  "compose", "write", "notify", "diagnose", "decide",
  "prioritize", "summarize", "review", "plan", "classify", "generate",
]);

/** 认得出的"会调模型"的调用面（只用于审计/违规判定，不参与 classify）。 */
export const MODEL_CALL_HINTS = Object.freeze([
  "directChat", "composeNotice", "writeShortNotice", "agentTurn",
  "provider.extract", "generateImage", "generateImageSaved", "subagent", "prompt.run",
]);

// ── 二、静默失败 ────────────────────────────────────────────────────────
export const SILENT_FAILURE = Object.freeze({
  threshold: 3,                    // 连续 3 次没有产出就告警
  cooldownMs: 30 * 60 * 1000,      // 同一作业 30 分钟内不重复告警
  windowMs: 24 * 60 * 60 * 1000,   // 看最近 24 小时心跳
});

export const RUN_LOG_REL = path.join("记忆", "运行时", "定时任务心跳.jsonl");
export const ALERT_LOG_REL = path.join("记忆", "运行时", "定时任务告警.jsonl");

// ── 三、classify / plan ────────────────────────────────────────────────

const hasJudgement = (j) => {
  const v = j?.judgement;
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(String(v ?? "").trim());
};
const text = (v) => String(v ?? "").trim();

/**
 * 作业分类（纯函数）。
 *
 * 只按**产出性质**判，不看它现在有没有调模型——否则"deterministic 却在调模型"
 * 这种违规永远抓不到（会被分类直接吞掉）。
 *
 * @param {{id?:string, output?:string, task?:string, judgement?:string|string[],
 *          needsJudgement?:boolean, deterministic?:boolean, fixed?:boolean}} job
 * @returns {'deterministic'|'needs-judgement'}
 */
export function classifyJob(job = {}) {
  const j = job && typeof job === "object" ? job : {};
  // ① 明确声明要判断（优先于 fixed —— 不许用 fixed 洗掉判断需求）
  if (j.needsJudgement === true) return JOB_KIND.NEEDS_JUDGEMENT;
  if (hasJudgement(j)) return JOB_KIND.NEEDS_JUDGEMENT;
  // ② 明确声明固定产出
  if (j.deterministic === true || j.fixed === true) return JOB_KIND.DETERMINISTIC;
  // ③ 产出/任务名能一眼看出
  const out = text(j.output);
  if (out && FIXED_OUTPUTS.includes(out)) return JOB_KIND.DETERMINISTIC;
  if (out && JUDGEMENT_TASKS.includes(out)) return JOB_KIND.NEEDS_JUDGEMENT;
  const task = text(j.task);
  if (task && FIXED_OUTPUTS.includes(task)) return JOB_KIND.DETERMINISTIC;
  if (task && JUDGEMENT_TASKS.includes(task)) return JOB_KIND.NEEDS_JUDGEMENT;
  // ④ 判不出来 → 按 needs-judgement（安全默认：给它补采集步骤，别悄悄烧 token）
  return JOB_KIND.NEEDS_JUDGEMENT;
}

/** classifyJob 的人读理由（审计表用）。 */
export function classifyReason(job = {}) {
  const j = job && typeof job === "object" ? job : {};
  const kind = classifyJob(j);
  if (j.needsJudgement === true) return "声明了 needsJudgement";
  if (hasJudgement(j)) return `要判断：${[].concat(j.judgement).join("、")}`;
  if (j.deterministic === true || j.fixed === true) return "声明了固定产出（fixed）";
  const out = text(j.output || j.task);
  if (kind === JOB_KIND.DETERMINISTIC) return `固定产出「${out}」→ 脚本就够`;
  if (out && JUDGEMENT_TASKS.includes(out)) return `产出「${out}」要判断`;
  return "说不清产出性质 → 保守按要判断处理";
}

/** 声明的模型调用面（job.modelCalls 或 ctx.modelCalls）。 */
export function modelCallsOf(job = {}, ctx = {}) {
  const a = Array.isArray(job?.modelCalls) ? job.modelCalls : [];
  const b = Array.isArray(ctx?.modelCalls) ? ctx.modelCalls : [];
  return [...new Set([...a, ...b].map((x) => text(x)).filter(Boolean))];
}

const normEvidence = (x) => {
  if (x && typeof x === "object") {
    const source = text(x.source || x.from || x.path);
    if (!source) return null;
    return { source, what: text(x.what || x.detail || x.fields || "") };
  }
  const s = text(x);
  return s ? { source: s, what: "" } : null;
};

/**
 * 采集清单：needs-judgement 的第一步要拿哪些证据。
 * 优先用作业自己声明的 evidence；其次用调用方给的 ctx.evidence。
 * 空清单 = 让模型凭空判断 → planJob 返回 blocked（不是违规，是这一步根本没做完）。
 */
export function planEvidence(job = {}, ctx = {}) {
  const declared = Array.isArray(job?.evidence) ? job.evidence : [];
  const fallback = Array.isArray(ctx?.evidence) ? ctx.evidence : [];
  return (declared.length ? declared : fallback).map(normEvidence).filter(Boolean);
}

/**
 * 执行计划（纯函数）。
 *
 * deterministic：单步 `run`（脚本）。若声明/检测到会调模型 → `violation`（ok:false）。
 * needs-judgement：两步，step1 必须 mode:'deterministic' + action:'collect'（带 collect 清单），
 *                  step2 才 mode:'llm'。没有证据清单 → `blocked`。
 *
 * @param {object} job
 * @param {{evidence?:Array, modelCalls?:Array, script?:string}} ctx
 * @returns {{ok:boolean, kind:string, id:string, steps:Array, violation?:object, blocked?:object}}
 */
export function planJob(job = {}, ctx = {}) {
  const j = job && typeof job === "object" ? job : {};
  const id = text(j.id || j.name || j.label) || "(未命名)";
  const kind = classifyJob(j);
  const calls = modelCallsOf(j, ctx);

  if (kind === JOB_KIND.DETERMINISTIC) {
    const steps = [{
      step: 1, mode: "deterministic", action: "run",
      script: text(j.script || ctx.script) || `${id}.script`,
      note: "纯脚本：检查/清理/归档/统计都不需要模型",
    }];
    if (calls.length) {
      return {
        ok: false, kind, id, steps,
        violation: {
          code: "deterministic-calls-model",
          jobId: id,
          modelCalls: calls,
          message: `固定产出的作业调了模型（${calls.join("、")}）——这就是 Hermes 烧 6000 万 token 的那条路`,
        },
      };
    }
    return { ok: true, kind, id, steps };
  }

  const collect = planEvidence(j, ctx);
  const steps = [
    {
      step: 1, mode: "deterministic", action: "collect", collect,
      note: "先确定性采集：这一步跑完、证据落盘，才许调模型",
    },
    {
      step: 2, mode: "llm", action: "judge",
      modelCalls: calls.length ? calls : ["(执行时按需)"],
      note: "只拿第 1 步采到的证据，不额外翻盘",
    },
  ];
  if (!collect.length) {
    return {
      ok: false, kind, id, steps,
      blocked: {
        code: "no-evidence-planned",
        jobId: id,
        message: "要判断，但没声明第一步采集什么证据——空着手问模型等于让它编",
      },
    };
  }
  return { ok: true, kind, id, steps };
}

// ── 四、静态审计名单（真实定时任务；只报告，不改别人实现）────────────────────
//
// where 的行号会漂，定位用 id 搜。modelCalls 是"这条代码路径会不会碰模型"的结论，
// 不是声明——审计表里 deterministic 的条目 modelCalls 必须为空，测试钉住。
export const JOB_INVENTORY = Object.freeze([
  // ── server.mjs 的定时器 ──
  { id: "degradation-auto", where: "server.mjs 10 分钟循环", every: "10 分钟（抖动 8%）", output: "health-check", modelCalls: [],
    note: "退化自评 low 档自动执行：读台账 + 最多写一个分项闸" },
  { id: "telemetry-sweep", where: "server.mjs:586", every: "60 分钟", output: "health-check", modelCalls: [],
    note: "崩溃/重启计数，纯统计" },
  { id: "detached-reaper", where: "server.mjs:941", every: "20 秒", output: "cleanup", modelCalls: [],
    note: "脱链作业对账" },
  { id: "mood-diary", where: "server.mjs:963", every: "30 分钟", output: "snapshot", modelCalls: [],
    note: "按模板写心情日记" },
  { id: "memory-hygiene", where: "server.mjs:977", every: "6 小时", output: "archive", modelCalls: [],
    note: "经验库/记忆日志超限归档，只移动不删除" },
  { id: "scheduler-briefs", where: "server.mjs:4181-4185", every: "10 分钟（抖动 8%）", judgement: ["早/晚/反思简报的措辞"], modelCalls: ["composeNotice→directChat"],
    evidence: [{ source: "记忆/运行时/简报.json", what: "今天发没发过" }, { source: "会话列表", what: "今天动过的会话数" }, { source: "经验库", what: "今天沉淀条数" }],
    note: "要写给人看的话，确实要模型；但事实（几件事、几条沉淀）已经由脚本先数好" },
  { id: "scheduler-deterministic", where: "server.mjs:4186-4250（同一个 10 分钟定时器里的其它子任务）", every: "10 分钟（抖动 8%）", output: "audit", modelCalls: [],
    note: "自改影子提案 / 推送超时标忽略 / 授权过期清理 / 人格块同步 / 看门狗判偏 / 脑区自调——全是纯函数" },
  { id: "companion-nudge", where: "server.mjs:4252", every: "5 分钟", judgement: ["决定要不要打扰、写一句话"], modelCalls: ["composeNoticeFor"],
    evidence: [{ source: "记忆/运行时/主动预算.json", what: "今天还剩几次" }, { source: "会话列表", what: "哪个会话冷了很久" }, { source: "免打扰时段", what: "现在能不能说话" }],
    note: "外层策略（预算/冷却/静默时段）是确定性闸，只有真要说时才调模型" },
  { id: "design-commission", where: "server.mjs:4258", every: "60 秒", judgement: ["按委托出图/排版"], modelCalls: ["generateImageSaved"],
    evidence: [{ source: "设计委托文件", what: "到期且没跑过的委托" }],
    note: "到期检查是脚本，出图是模型（而且只在有到期委托时）" },
  { id: "jobs-report", where: "server.mjs:7907-7922", every: "60 秒", judgement: ["写一两句汇报", "挑明天想做的事"], modelCalls: ["writeShortNotice", "composeNoticeFor"],
    evidence: [{ source: "作业台账", what: "high 级未汇报" }, { source: "会话/承诺/时间任务", what: "今日建议的素材" }],
    note: "60 秒只是扫描；模型调用有 20 分钟冷却 + 空闲前置条件" },
  { id: "guardian-heartbeat", where: "server.mjs:7923", every: "30 秒", output: "heartbeat", modelCalls: [], note: "给守护进程判死用的心跳" },
  { id: "memory-version", where: "server.mjs:8356", every: "30 分钟", output: "snapshot", modelCalls: [], note: "记忆 git 快照" },
  { id: "wiki-build", where: "server.mjs:8365", every: "6 小时", output: "sync", modelCalls: [], note: "记忆 → 主题页，模板拼装" },
  { id: "doc-diff", where: "server.mjs:8388", every: "10 分钟", output: "audit", modelCalls: [], note: "文档基线对比" },
  { id: "patch-track", where: "server.mjs:8399", every: "30 分钟", output: "sync", modelCalls: [], note: "补丁分支状态同步" },
  { id: "proactive-sweep", where: "server.mjs:8417", every: "10 分钟", output: "sweep", modelCalls: [], note: "开环扫描 + 催/升级判定，全纯函数" },
  { id: "promise-sweep", where: "server.mjs:8438", every: "60 秒", judgement: ["到点的承诺要真的做完并汇报"], modelCalls: ["loopback chat→模型轮次"],
    evidence: [{ source: "承诺台账", what: "到点未做的承诺" }],
    note: "扫描是脚本；只有真有到期承诺才起一轮" },
  { id: "autopatch-sweep", where: "server.mjs:8456", every: "60 分钟（YUANSHU_AUTOPATCH=1 才挂）", judgement: ["生成补丁代码"], modelCalls: ["patch generator"],
    evidence: [{ source: "进化事件/提案池", what: "够格的提案" }], note: "默认关；开了也每小时最多一个、只建分支不并 main" },
  { id: "dream-cycle", where: "server.mjs:8493", every: "6 小时", output: "sweep", modelCalls: [], note: "回放 + 策略进化，不调模型" },
  { id: "subscription-check", where: "server.mjs:8564", every: "6 小时", output: "reminder", modelCalls: [], note: "解析订阅表日期" },
  { id: "session-sweep", where: "server.mjs:8577", every: "6 小时", output: "cleanup", modelCalls: [], note: "空会话进回收站" },
  { id: "recall-rebuild", where: "server.mjs:8592", every: "60 分钟", output: "index", modelCalls: [], note: "回忆索引增量重建" },
  { id: "loop-lag-monitor", where: "server.mjs:8611", every: "30 秒", output: "health-check", modelCalls: [], note: "事件循环停顿采样" },
  { id: "watchdog-heartbeat", where: "server.mjs:8693", every: "5 秒", output: "heartbeat", modelCalls: [], note: "有轮次在跑才写盘" },
  { id: "forget-cycle", where: "server.mjs:8723", every: "24 小时", output: "archive", modelCalls: [], note: "遗忘：只归档不删除" },
  // ── engine 层自带节拍的周期引擎 ──
  { id: "time-engine-tick", where: "engine/time-engine.mjs:241", every: "20 秒", output: "sweep", modelCalls: [],
    note: "到点判定是纯函数；真的跑任务是下面那条" },
  { id: "time-engine-task", where: "engine/time-engine.mjs:111 execute()", every: "由任务自己的 at/date 决定", judgement: ["按 prompt 干活"], modelCalls: ["onTaskRun→模型轮次"],
    evidence: [{ source: "任务定义", what: "prompt/label/model" }, { source: "上次运行结果", what: "是否已经跑过" }],
    note: "用户写的 prompt 天然要模型；调度器本身不该背这个锅" },
  { id: "watch-duty", where: "engine/watch-duty.mjs:1076", every: "15 秒", output: "sweep", modelCalls: [],
    note: "文件头就写着「未命中零模型调用」，判定全是纯函数" },
  { id: "knowledge-worker", where: "engine/knowledge-worker.mjs:84", every: "60 秒（启动延后 120 秒）", judgement: ["提炼/判定知识是否成立"], modelCalls: ["provider.extract（remoteEnabled 时）"],
    evidence: [{ source: "来源快照", what: "locator/hash" }, { source: "现有知识条目", what: "是否重复" }, { source: "policy", what: "允许不允许远端" }],
    note: "已经是「先采集→再提取→再校验」；remoteEnabled 关闭时走本地提取，一步模型都不调" },
  { id: "cultivation-tasks", where: "engine/cultivation/tasks.mjs:102", every: "5 秒", judgement: ["培养任务要模型干活"], modelCalls: ["task-dispatch→模型"],
    evidence: [{ source: "任务仓库", what: "queued/running 的任务" }],
    note: "5 秒只是取任务，真干活才调模型" },
  { id: "email-bridge-poll", where: "engine/email-bridge.mjs:317", every: "配置的轮询间隔", output: "sync", modelCalls: [],
    note: "取信 + 通知，不生成正文" },
  // ── 独立进程里的周期循环（setTimeout 自续）──
  { id: "watchdog-monitor", where: "watchdog.cjs:330", every: "5 秒（启动窗）/ 30 秒（稳态）", output: "health-check", modelCalls: [],
    note: "守护进程巡检：探端口 + 判僵死，纯 HTTP 与进程判活，不碰模型" },
]);

/**
 * 审计：把名单跑一遍分类/计划，输出"哪些其实不需要模型"的真实清单。
 * 只报告，不改任何作业实现。
 */
export function auditJobs(jobs = JOB_INVENTORY) {
  const rows = [];
  const violations = [];
  const noModelNeeded = [];
  const needsJudgement = [];
  for (const job of jobs) {
    const kind = classifyJob(job);
    const calls = modelCallsOf(job);
    const plan = planJob(job);
    const row = {
      id: String(job.id || ""), where: String(job.where || ""), every: String(job.every || ""),
      kind, reason: classifyReason(job), output: String(job.output || ""),
      modelCalls: calls, ok: plan.ok === true, note: String(job.note || ""),
    };
    rows.push(row);
    if (kind === JOB_KIND.DETERMINISTIC) {
      noModelNeeded.push(row.id);
      if (calls.length) violations.push({ jobId: row.id, modelCalls: calls, code: "deterministic-calls-model" });
    } else {
      needsJudgement.push(row.id);
    }
  }
  return {
    ok: violations.length === 0,
    total: rows.length,
    rows, violations, noModelNeeded, needsJudgement,
    deterministicCount: noModelNeeded.length,
    needsJudgementCount: needsJudgement.length,
  };
}

// ── 五、静默失败：连续 N 次没有产出 ──────────────────────────────────────

/**
 * 纯函数：从心跳记录里找"连续 N 次没有产出"的作业。
 * 只认产出的**末段**：produced:true 会清零；因此"偶尔成功一次"不会告警（那是抖，不是死）。
 *
 * @param {Array<{jobId:string, at:number, produced:boolean}>} records
 * @param {{threshold?:number}} opts
 * @returns {Array<{jobId:string, streak:number, since:number, lastAt:number, code:string}>}
 */
export function detectSilentFailures(records = [], { threshold = SILENT_FAILURE.threshold } = {}) {
  const th = Math.max(1, Math.floor(Number(threshold) || SILENT_FAILURE.threshold));
  const byJob = new Map();
  const sorted = (Array.isArray(records) ? records : [])
    .filter((r) => r && r.jobId)
    .slice()
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  for (const r of sorted) {
    const id = String(r.jobId);
    const cur = byJob.get(id) || { jobId: id, streak: 0, since: 0, lastAt: 0, runs: 0, lastProducedAt: 0 };
    cur.runs += 1;
    cur.lastAt = Number(r.at) || cur.lastAt;
    if (r.produced === true) {
      cur.streak = 0; cur.since = 0; cur.lastProducedAt = cur.lastAt;
    } else {
      if (!cur.streak) cur.since = cur.lastAt;
      cur.streak += 1;
    }
    byJob.set(id, cur);
  }
  return [...byJob.values()]
    .filter((j) => j.streak >= th)
    .map((j) => ({ jobId: j.jobId, streak: j.streak, since: j.since, lastAt: j.lastAt, code: "silent-failure" }));
}

const readTail = (file, { maxBytes = 256 * 1024, maxLines = 2000 } = {}) => {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    if (start > 0 && lines.length) lines.shift();
    return lines.slice(-maxLines).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

const appendJsonl = (file, row) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
    return true;
  } catch { return false; }
};

/**
 * 记一次定时任务心跳；连续 threshold 次没有产出就写一条告警（同作业 30 分钟冷却）。
 *
 * produced 的语义：**这一拍跑完并落了结论**（哪怕没有动作可做），不是"有动作才算出活"。
 * 抛错/被跳过/什么都没算 = produced:false。
 *
 * @param {string} wsRoot
 * @param {{jobId:string, at?:number, produced?:boolean, note?:string, threshold?:number, cooldownMs?:number}} p
 * @returns {{ok:boolean, jobId:string, streak:number, alerted:boolean, error?:string}}
 */
export function recordJobRun(wsRoot, { jobId, at = Date.now(), produced = false, note = "", threshold = SILENT_FAILURE.threshold, cooldownMs = SILENT_FAILURE.cooldownMs } = {}) {
  const root = String(wsRoot || "");
  const id = text(jobId);
  if (!root || !id) return { ok: false, jobId: id, streak: 0, alerted: false, error: "缺 wsRoot 或 jobId" };
  const time = Number(at) || Date.now();
  const row = { at: time, jobId: id, produced: produced === true, ...(note ? { note: String(note).slice(0, 200) } : {}) };
  if (!appendJsonl(path.join(root, RUN_LOG_REL), row)) {
    return { ok: false, jobId: id, streak: 0, alerted: false, error: "心跳写不进去" };
  }
  const rows = readTail(path.join(root, RUN_LOG_REL)).filter((r) => String(r?.jobId || "") === id);
  const hit = detectSilentFailures(rows, { threshold: 1 }).find((x) => x.jobId === id) || null;
  const streak = hit?.streak || 0;
  if (streak < Math.max(1, Number(threshold) || SILENT_FAILURE.threshold)) {
    return { ok: true, jobId: id, streak, alerted: false };
  }

  const last = readTail(path.join(root, ALERT_LOG_REL), { maxBytes: 64 * 1024, maxLines: 500 })
    .filter((r) => String(r?.jobId || "") === id)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))[0];
  if (last && time - (Number(last.at) || 0) < cooldownMs) {
    return { ok: true, jobId: id, streak: hit.streak, alerted: false, cooled: true };
  }
  const alert = {
    at: time, by: "scheduled-policy", jobId: id, code: "silent-failure",
    streak: hit.streak, since: hit.since,
    note: String(note || "").slice(0, 200),
    message: `定时任务「${id}」连续 ${hit.streak} 次没有产出`,
  };
  const ok = appendJsonl(path.join(root, ALERT_LOG_REL), alert);
  return { ok, jobId: id, streak: hit.streak, alerted: ok, alert };
}

/**
 * 读定时任务健康（给 GET /api/degradation 用）。
 * @returns {{at:number, windowMs:number, jobs:Array, silent:Array, alerts:Array, reasons:string[]}}
 */
export function readScheduledHealth(wsRoot, { now = Date.now(), windowMs = SILENT_FAILURE.windowMs, threshold = SILENT_FAILURE.threshold, maxJobs = 20 } = {}) {
  const root = String(wsRoot || "");
  const at = Number(now) || Date.now();
  const since = at - Math.max(0, Number(windowMs) || SILENT_FAILURE.windowMs);
  const empty = { at, windowMs, jobs: [], silent: [], alerts: [], reasons: [] };
  if (!root) return empty;
  const runs = readTail(path.join(root, RUN_LOG_REL))
    .map((r) => ({ ...r, at: Number(r?.at) || 0 }))
    .filter((r) => r.jobId && r.at >= since);
  const alerts = readTail(path.join(root, ALERT_LOG_REL), { maxBytes: 64 * 1024, maxLines: 200 })
    .map((r) => ({ ...r, at: Number(r?.at) || 0 }))
    .filter((r) => r.jobId && r.at >= since)
    .sort((a, b) => b.at - a.at)
    .slice(0, 20);
  if (!runs.length && !alerts.length) return empty;

  const jobs = new Map();
  for (const r of runs.slice().sort((a, b) => a.at - b.at)) {
    const cur = jobs.get(r.jobId) || { jobId: r.jobId, runs: 0, streak: 0, lastAt: 0, lastProducedAt: 0 };
    cur.runs += 1;
    cur.lastAt = r.at;
    if (r.produced === true) { cur.streak = 0; cur.lastProducedAt = r.at; }
    else cur.streak += 1;
    jobs.set(r.jobId, cur);
  }
  const silent = [...jobs.values()].filter((j) => j.streak >= Math.max(1, Number(threshold) || SILENT_FAILURE.threshold));
  const reasons = alerts.map((a) => `定时任务「${a.jobId}」连续 ${Number(a.streak) || 0} 次没有产出（最后 ${new Date(Number(a.at) || at).toISOString()}，明细见 记忆/运行时/定时任务告警.jsonl）`);
  return {
    at, windowMs,
    jobs: [...jobs.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, Math.max(1, Number(maxJobs) || 20)),
    silent: silent.map((j) => ({ jobId: j.jobId, streak: j.streak, lastAt: j.lastAt })),
    alerts,
    reasons,
  };
}
