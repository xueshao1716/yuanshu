# 定时任务双模式：固定产出走脚本，要判断的先采集再问模型

> 2026-11-09 · 规范落在 `engine/scheduled-policy.mjs`（纯函数 + 代码常量），测试在
> `tests/unit/scheduled-policy.test.mjs`。本文是人读版；两者不一致时以代码常量 `POLICY` 为准。

## 一、为什么要这条规范

xinyu-hermes 的教训是两个错误叠在一起：

1. **所有 cron 都用 LLM 跑**——检查健康、清理缓存、统计数字这类"固定产出"的活也去问模型，
   一天烧掉 6000 万 token；
2. **失败被静默挡下**——花了钱、没结论、没人知道。

元枢的定时任务不少（10 分钟循环里就挂了十几个子任务，另有 5 分钟 nudge、60 秒作业汇报、
watch-duty 15 秒、time-engine 20 秒、清理/归档/快照/索引…）。**判断"这一拍该不该动手"可以便宜，
判断"这话该怎么说"才贵。** 便宜的那半永远该是脚本。

## 二、两种模式

| 模式 | 什么时候用 | 执行方式 | 例子 |
|---|---|---|---|
| `deterministic` | **固定产出**：检查健康、清理、归档、统计、快照、索引、同步、提醒、心跳、审计 | 纯脚本，**一次模型都不许调** | 事件循环停顿采样、记忆归档、回忆索引重建、watch-duty 判定 |
| `needs-judgement` | **要判断**：写文案、决定是否打扰、诊断、取舍、排序、提炼 | 第一步确定性采集，第二步才 LLM | 早晚简报、主动 nudge、作业汇报、时间任务执行 |

`classifyJob(job)` 的判定顺序（`job` 只需要 `output` / `task` / `judgement` 三者之一）：

1. `needsJudgement: true` → `needs-judgement`
2. `judgement` 非空（字符串或数组）→ `needs-judgement`（**优先于 fixed**，不许用 fixed 洗掉判断需求）
3. `deterministic: true` / `fixed: true` → `deterministic`
4. `output` / `task` ∈ `FIXED_OUTPUTS` → `deterministic`；∈ `JUDGEMENT_TASKS` → `needs-judgement`
5. 都说不清 → **按 `needs-judgement` 处理**（宁可多一步采集，也不许悄悄烧 token）

`FIXED_OUTPUTS = health-check / cleanup / archive / stats / snapshot / index / sync / sweep / reminder / heartbeat / audit`
`JUDGEMENT_TASKS = compose / write / notify / diagnose / decide / prioritize / summarize / review / plan / classify / generate`

## 三、`planJob`：两步顺序是硬约束

`needs-judgement` 的作业必须给出两步计划，**第一步不允许是模型**：

```js
planJob({ id: "morning-brief", judgement: ["早上那段话怎么说"],
  evidence: [{ source: "记忆/运行时/待办.json", what: "还剩几件" },
             { source: "会话列表", what: "昨天动过几个会话" }] })
// →
{ ok: true, kind: "needs-judgement", steps: [
  { step: 1, mode: "deterministic", action: "collect",
    collect: [{ source: "记忆/运行时/待办.json", what: "还剩几件" }, ...] },   // 先采集、先落盘
  { step: 2, mode: "llm", action: "judge", modelCalls: ["(执行时按需)"] },      // 只拿第 1 步的证据
] }
```

- **拿不出证据清单** → `blocked: { code: "no-evidence-planned" }`。空着手问模型，等于让它编。
- **deterministic 却会调模型** → `violation: { code: "deterministic-calls-model", modelCalls: [...] }`。
  这是 Hermes 那条路的入口，必须停下改回脚本，不许"先跑着"。

比例尺：元枢真实名单里 **23 / 32 是脚本活，只有 9 条真要判断**（见下）。

## 四、静默失败检测

- 每个定时任务每跑一拍记一行心跳：`记忆/运行时/定时任务心跳.jsonl`（`{at, jobId, produced, note}`）。
  `produced` 的语义是**这一拍跑完并落了结论**（哪怕没有动作可做也算），抛错/被跳过/什么都没算 = `false`。
- 连续 **3** 次 `produced:false` → 写 `记忆/运行时/定时任务告警.jsonl`，同一作业 30 分钟冷却
  （不刷屏），出一次真产出就清零（"偶尔抖一下"不告警，只抓"一直死"）。
- 告警会并进 `GET /api/degradation`：`assessment.reasons` 多一条人话，`scheduled` 里有
  `jobs / silent / alerts` 明细。**不新增维度、不改总分算式**——看板仍是五维，告警是理由不是分数。
- 当前接线：10 分钟循环里的 `degradation-auto` 已经按这个格式记心跳，跑的每一拍都算数。

## 五、审计：元枢现有定时任务（真实名单，32 条）

只报告，**没有擅自改任何作业实现**。`where` 的行号会漂，定位用 `id` 搜
（名单本体：`engine/scheduled-policy.mjs` 的 `JOB_INVENTORY`）。

口径：workspace 级周期作业 + engine 层自带节拍的引擎 + 独立守护进程的巡检循环。
SSE 心跳、单次任务的轮询（媒体任务/probe/锁续租）属于连接保活，不算业务定时任务，不在表里。

| # | 作业 | 出处 | 节拍 | 判定 | 模型调用 |
|---|---|---|---|---|---|
| 1 | degradation-auto | server.mjs 10 分钟循环 | 10 分钟（抖动 8%） | deterministic | — |
| 2 | telemetry-sweep | server.mjs:586 | 60 分钟 | deterministic | — |
| 3 | detached-reaper | server.mjs:941 | 20 秒 | deterministic | — |
| 4 | mood-diary | server.mjs:963 | 30 分钟 | deterministic | — |
| 5 | memory-hygiene | server.mjs:977 | 6 小时 | deterministic | — |
| 6 | scheduler-briefs | server.mjs:4181-4185 | 10 分钟（抖动 8%） | needs-judgement | composeNotice→directChat |
| 7 | scheduler-deterministic | server.mjs:4186-4250（同一 10 分钟定时器的其它子任务） | 10 分钟（抖动 8%） | deterministic | — |
| 8 | companion-nudge | server.mjs:4252 | 5 分钟 | needs-judgement | composeNoticeFor |
| 9 | design-commission | server.mjs:4258 | 60 秒 | needs-judgement | generateImageSaved |
| 10 | jobs-report | server.mjs:7907-7922 | 60 秒 | needs-judgement | writeShortNotice / composeNoticeFor |
| 11 | guardian-heartbeat | server.mjs:7923 | 30 秒 | deterministic | — |
| 12 | memory-version | server.mjs:8356 | 30 分钟 | deterministic | — |
| 13 | wiki-build | server.mjs:8365 | 6 小时 | deterministic | — |
| 14 | doc-diff | server.mjs:8388 | 10 分钟 | deterministic | — |
| 15 | patch-track | server.mjs:8399 | 30 分钟 | deterministic | — |
| 16 | proactive-sweep | server.mjs:8417 | 10 分钟 | deterministic | — |
| 17 | promise-sweep | server.mjs:8438 | 60 秒 | needs-judgement | loopback chat→模型轮次 |
| 18 | autopatch-sweep | server.mjs:8456 | 60 分钟（YUANSHU_AUTOPATCH=1 才挂） | needs-judgement | patch generator |
| 19 | dream-cycle | server.mjs:8493 | 6 小时 | deterministic | — |
| 20 | subscription-check | server.mjs:8564 | 6 小时 | deterministic | — |
| 21 | session-sweep | server.mjs:8577 | 6 小时 | deterministic | — |
| 22 | recall-rebuild | server.mjs:8592 | 60 分钟 | deterministic | — |
| 23 | loop-lag-monitor | server.mjs:8611 | 30 秒 | deterministic | — |
| 24 | watchdog-heartbeat | server.mjs:8693 | 5 秒 | deterministic | — |
| 25 | forget-cycle | server.mjs:8723 | 24 小时 | deterministic | — |
| 26 | time-engine-tick | engine/time-engine.mjs:241 | 20 秒 | deterministic | — |
| 27 | time-engine-task | engine/time-engine.mjs:111 `execute()` | 由任务自己的 at/date 决定 | needs-judgement | onTaskRun→模型轮次 |
| 28 | watch-duty | engine/watch-duty.mjs:1076 | 15 秒 | deterministic | — |
| 29 | knowledge-worker | engine/knowledge-worker.mjs:84 | 60 秒（启动延后 120 秒） | needs-judgement | provider.extract（remoteEnabled 时） |
| 30 | cultivation-tasks | engine/cultivation/tasks.mjs:102 | 5 秒 | needs-judgement | task-dispatch→模型 |
| 31 | email-bridge-poll | engine/email-bridge.mjs:317 | 配置的轮询间隔 | deterministic | — |
| 32 | watchdog-monitor | watchdog.cjs:330 | 5 秒（启动窗）/ 30 秒（稳态） | deterministic | — |

### 哪些其实不需要模型（23 条）

`degradation-auto`、`telemetry-sweep`、`detached-reaper`、`mood-diary`、`memory-hygiene`、
`scheduler-deterministic`（自改影子提案 / 推送超时标忽略 / 授权过期清理 / 人格块同步 /
看门狗判偏 / 脑区自调）、`guardian-heartbeat`、`memory-version`、`wiki-build`、`doc-diff`、
`patch-track`、`proactive-sweep`、`dream-cycle`、`subscription-check`、`session-sweep`、
`recall-rebuild`、`loop-lag-monitor`、`watchdog-heartbeat`、`forget-cycle`、`time-engine-tick`、
`watch-duty`、`email-bridge-poll`、`watchdog-monitor`。

### 真要判断的 9 条（别硬砍成脚本）

`scheduler-briefs`（简报措辞）、`companion-nudge`（决定要不要打扰）、`design-commission`（出图）、
`jobs-report`（写一两句汇报）、`promise-sweep`（到点的承诺真去干）、`autopatch-sweep`（生成补丁）、
`time-engine-task`（用户写的 prompt）、`knowledge-worker`（提炼知识）、`cultivation-tasks`（培养任务）。

其中三条值得单独说：

- **同一个 10 分钟定时器里混着两种模式**（#6 / #7）。以前看它就是一个 cron；现在拆开看，
  简报要模型，看门狗/人格同步/推送过期清理一次模型都不该调。这就是 Hermes 教训的直接落点。
- **`knowledge-worker` 已经是两步式**：先 `collect` 快照 → 再 `extract`（本地提取或远端 provider）
  → 再 `validate`。`remoteEnabled` 关闭时一步模型都不调，是这条规范的正例。
- **`time-engine` 的调度器（#26）不该背模型的锅**：到点判定是纯函数，真跑任务的是 #27。

## 六、接一个新的定时任务时

```js
import { classifyJob, planJob, recordJobRun } from "./engine/scheduled-policy.mjs";

// 1) 先想清楚产出是什么（说不清就按 needs-judgement）
const job = { id: "cache-cleanup", output: "cleanup" };          // 固定产出
// const job = { id: "wrap-up", judgement: ["今天该怎么收尾"], evidence: [...] };

// 2) 跑之前自检：deterministic 调模型会拿到 violation，别上线
const plan = planJob(job);
if (!plan.ok) throw new Error(plan.violation?.message || plan.blocked?.message);

// 3) 每一拍记心跳（哪怕这拍没活干），连续 3 次没产出会自动告警
recordJobRun(wsRoot, { jobId: job.id, produced: true, note: "clean 0 个" });
```

## 七、边界（如实）

- 这份规范**只审不改**：22 条脚本活目前的实现本来就是脚本，改名/重构留到以后按需做。
- `classifyJob` 判的是**产出性质**，不看它现在有没有调模型——否则"deterministic 却在调模型"
  这种违规会被分类直接吞掉。
- 静默失败只覆盖**显式记了心跳**的作业。本次只接了 `degradation-auto`；其它作业按需再接，
  没接的不会假装"健康"（看板里也不会出现它们的名字）。
- 告警只进 `/api/degradation` 的 reasons / scheduled，**不改五维总分**——分数是"这轮多差"，
  告警是"哪个定时器死了"，两件事不该互相污染。
