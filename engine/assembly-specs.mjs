// ===== engine/assembly-specs.mjs —— 18 项能力的装配清单（2026-11-10）=====
//
// 填法（判据见 engine/assembly.mjs 文件头）：
//   files      能力落在哪个模块（任一存在就算 defined）
//   exports    该模块**真的有**的导出符号（import() 拿得到）
//   tests      覆盖它的测试文件（任一存在就算 implemented 通过）
//   callSites  运行时**真的会执行到它**的非测试文件（真调用，不是 import）
//   switches   能拧的旋钮：env / config / route / gate（+ flag：CLI 参数）
//
// 2026-11-10 逐条用 grep 核过路径/导出名/调用点（不是照抄需求里的名字）。
// 符号挑的是辨识度高的：status/promote/summary 这种通用词会在别的模块里撞名，判出来是假的。
// 顺序按"情绪 → 关系 → 基因 → 成长 → 账本 → 自评自救 → 任务/归因/评估 → 闸门与工具 → 清理与体检"排。

export const CAPABILITIES = [
  // ── 情绪与关系 ──
  {
    id: "emotion-events",
    name: "情绪事件",
    files: ["engine/emotion.mjs"],
    exports: ["applyEvent", "behaviorModifiers", "emotionPrompt"],
    tests: ["tests/unit/emotion-events.test.mjs"],
    // applyEvent：unified-chat 工具事件成功后调；emotionPrompt：yuanshu-emotion 开轮注入
    callSites: ["engine/unified-chat.mjs", "engine/yuanshu-emotion.mjs"],
    switches: [{ kind: "route", path: "/api/emotion" }],
  },
  {
    id: "relationship",
    name: "关系层",
    files: ["engine/relationship.mjs"],
    exports: ["recordInteraction", "positiveTrustGain", "current"],
    tests: ["tests/unit/relationship.test.mjs"],
    // recordInteraction：unified-chat 收轮时按本轮正负记账；current：GET /api/relationship 只读查状态
    callSites: ["engine/unified-chat.mjs", "server.mjs"],
    // 只读路由（2026-11-10）：状态/阶段/最近 20 条备注能查；没有可写开关（写开关要人批准）
    switches: [{ kind: "route", path: "/api/relationship" }],
  },

  // ── 基因与成长 ──
  {
    id: "genome-grn",
    name: "GRN 基因",
    files: ["engine/genome.mjs"],
    exports: ["advanceTurn", "express", "regulate"],
    tests: ["tests/unit/genome.test.mjs"],
    // advanceTurn 在 unified-chat 里是别名调用：import { advanceTurn as advanceGenomeTurn }
    callSites: ["engine/unified-chat.mjs"],
    switches: [{ kind: "route", path: "/api/genome" }],
  },
  {
    id: "growth",
    name: "成长换代",
    files: ["engine/genome-growth.mjs"],
    exports: ["promptLine", "advance", "measure"],
    tests: ["tests/unit/genome-growth.test.mjs"],
    // promptLine：yuanshu-emotion 以 growthPromptLine 别名注入；server 的 /api/genome/growth 读状态
    callSites: ["engine/yuanshu-emotion.mjs", "server.mjs"],
    switches: [{ kind: "route", path: "/api/genome/growth" }],
  },

  // ── 三本账 ──
  {
    id: "anti-patterns",
    name: "反模式台账",
    files: ["engine/anti-patterns.mjs"],
    exports: ["antiPatternPromptLine", "matchAntiPatterns", "runAntiPatternCheck", "loadAntiPatterns"],
    tests: ["tests/unit/anti-patterns.test.mjs"],
    // antiPatternPromptLine：yuanshu-emotion 开轮注入；runAntiPatternCheck：server 的 anti_pattern_check 工具；
    // loadAntiPatterns：GET /api/anti-patterns 只读查台账
    callSites: ["engine/yuanshu-emotion.mjs", "server.mjs"],
    // 只读路由（2026-11-10）：台账 + 分级计数能查；没有能关掉它的开关，更没有写开关
    switches: [{ kind: "route", path: "/api/anti-patterns" }],
    note: "可查状态 = 模型工具 anti_pattern_check + 只读路由 /api/anti-patterns；只有读口，没有可写开关。",
  },
  {
    id: "lesson-replay",
    name: "教训复习",
    files: ["engine/lesson-replay.mjs"],
    exports: ["replayPromptLine", "selectDueLessons", "markReplayed"],
    tests: ["tests/unit/lesson-replay.test.mjs"],
    // replayPromptLine：yuanshu-emotion 开轮注入；selectDueLessons：GET /api/lesson-replay 只读算"今天该念哪几条"
    callSites: ["engine/yuanshu-emotion.mjs", "server.mjs"],
    // 只读路由（2026-11-10）：复习状态 + 到期清单能查；没有可写开关（markReplayed 只在注入时被调）
    switches: [{ kind: "route", path: "/api/lesson-replay" }],
  },
  {
    id: "praise-ledger",
    name: "正向账本",
    files: ["engine/praise-ledger.mjs"],
    exports: ["praisePromptLine", "recordFromTurn", "judgePraise", "topPositive"],
    tests: ["tests/unit/praise-ledger.test.mjs"],
    // praisePromptLine：开轮注入；recordFromTurn：unified-chat 收轮按客观信号记账；topPositive：只读路由取权重最高的几条
    callSites: ["engine/yuanshu-emotion.mjs", "engine/unified-chat.mjs", "server.mjs"],
    // 只读路由（2026-11-10）：账本/正负比/注入状态能查；没有可写开关（记账仍由收轮那条路做）
    switches: [{ kind: "route", path: "/api/praise-ledger" }],
  },

  // ── 退化自评与自救 ──
  {
    id: "degradation",
    name: "退化自评",
    files: ["engine/degradation.mjs"],
    exports: ["degradationSnapshot", "assessDegradation", "collectSignals"],
    tests: ["tests/unit/degradation.test.mjs"],
    callSites: ["server.mjs"], // GET /api/degradation → degradationSnapshot
    switches: [
      { kind: "route", path: "/api/degradation" },
      { kind: "gate", path: "记忆/运行时/高危暂停.json" },
    ],
  },
  {
    id: "self-rescue",
    name: "自动自救",
    files: ["engine/degradation.mjs"],
    exports: ["applyLowRiskOnly", "applyActions", "releaseAutoPauses", "assessAndApply"],
    tests: ["tests/unit/degradation-auto.test.mjs"],
    // applyLowRiskOnly：server 的 10 分钟循环里自动执行 low 档动作；assessAndApply：POST /api/degradation/actions
    callSites: ["server.mjs"],
    switches: [
      { kind: "route", path: "/api/degradation/actions" },
      { kind: "gate", path: "记忆/运行时/高危暂停.json" },
    ],
  },

  // ── 定时任务 / 归因 / 评估 ──
  {
    id: "scheduled-dual",
    name: "定时任务双模式",
    files: ["engine/scheduled-policy.mjs"],
    exports: ["planJob", "auditJobs", "classifyJob"],
    tests: ["tests/unit/scheduled-policy.test.mjs"],
    // auditJobs/planJob：server 的 10 分钟循环里只读跑一次 + GET /api/scheduled/audit 看同一份快照
    callSites: ["server.mjs", "engine/degradation.mjs"],
    // 只读路由（2026-11-10）：分类/计划/违规能查；没有可写开关（本轮只做"看得见"）
    switches: [{ kind: "route", path: "/api/scheduled/audit" }],
    note: "同模块另一半已接：recordJobRun 在 server 的 10 分钟循环里落心跳，readScheduledHealth 被 degradation 读；"
      + "双模式判定 planJob/auditJobs 现在由 10 分钟循环只读调用，分类漂移打一行日志并落 记忆/运行时/定时任务审计.json，作业行为未改。",
  },
  {
    id: "failure-attribution",
    name: "失败归因",
    files: ["engine/failure-attribution.mjs"],
    exports: ["attributionReport", "enqueueImprovement", "classifyFailure"],
    tests: ["tests/unit/failure-attribution.test.mjs"],
    // failure-ledger 里调用（记失败时分类、看板时汇总、改进队列）；server 只透出看板路由
    callSites: ["engine/failure-ledger.mjs", "server.mjs"],
    switches: [{ kind: "route", path: "/api/failures/attribution" }],
  },
  {
    id: "evaluator",
    name: "独立评估器",
    files: ["engine/evaluator.mjs"],
    exports: ["evaluateWithRatchet", "judgeGate", "compareToReference"],
    tests: ["tests/unit/evaluator.test.mjs"],
    // evaluateWithRatchet：evolution-gate 的自改棘轮里调（mod.evaluateWithRatchet）
    callSites: ["engine/evolution-gate.mjs"],
    switches: [{ kind: "env", name: "YUANSHU_EVALUATOR" }], // =off 可整体跳过
  },

  // ── 闸门与工具 ──
  {
    id: "verify-check",
    name: "verify_check",
    files: ["engine/tools/verify-check.mjs"],
    exports: ["VERIFY_CHECK_TOOL", "executeVerifyCheck"],
    tests: ["tests/unit/verify-check.test.mjs"],
    callSites: ["server.mjs"], // 工具表里注册，executeVerifyCheck 真被包一层
    // 只读状态口（2026-11-10）：GET /api/tools/verify-check 报边界与允许口径
    switches: [{ kind: "route", path: "/api/tools/verify-check" }],
    note: "常开工具：只有只读状态路由，没有可写开关（允许根写死在 server 的 roots 里）；结果不落盘。",
  },
  {
    id: "self-change-admit",
    name: "自证准入",
    files: ["engine/self-change-admit.mjs"],
    exports: ["admit", "recordVerification", "buildCommitMessage"],
    tests: ["tests/unit/self-change-admit.test.mjs"],
    // admit 在 server 里是别名调用：import { admit as admitSelfChange }
    callSites: ["server.mjs", "engine/self-change-session.mjs"],
    switches: [{ kind: "route", path: "/api/selfchange/session/finish" }],
  },
  {
    id: "admission-bypass",
    name: "旁路留痕",
    files: ["engine/admission-bypass.mjs"],
    exports: ["recordBypass", "listBypasses", "countBypasses"],
    tests: ["tests/unit/admission-bypass.test.mjs"],
    // server 里四条"只备份不验证"的路径都记一笔（promote / snapshot / apply / autopatch）
    callSites: ["server.mjs"],
    switches: [{ kind: "route", path: "/api/selfchange/promote" }],
  },

  // ── 清理与体检 ──
  {
    id: "memory-forget",
    name: "遗忘清理",
    files: ["engine/memory/forget.mjs"],
    exports: ["runForgetCycle", "forgetStale", "shouldForget"],
    tests: ["tests/unit/memory-distill-forget-recall.test.mjs"],
    // runForgetCycle：POST /api/memory/forget（默认 dryRun）+ server 24 小时 forget-cycle
    callSites: ["server.mjs"],
    switches: [{ kind: "route", path: "/api/memory/forget" }],
  },
  {
    id: "vitality",
    name: "产出新鲜度",
    files: ["engine/vitality.mjs"],
    exports: ["auditVitality", "auditOne", "summarize"],
    tests: ["tests/unit/vitality.test.mjs"],
    // CLI（scripts/vitality.mjs）+ server 的 10 分钟循环里每 6 小时跑一次（落 记忆/运行时/体检.json）
    callSites: ["scripts/vitality.mjs", "server.mjs"],
    // 只读路由（2026-11-10）：GET /api/vitality 随时看最新体检；CLI 的 --strict/--root 仍只是报告选项
    switches: [{ kind: "route", path: "/api/vitality" }],
    note: "CLI 之外接了运行时：10 分钟循环里每 6 小时只读体检一次，有 never/stale 只打一行日志（不推送）。",
  },
  {
    id: "import-preflight",
    name: "符号预检",
    files: ["scripts/lib/import-preflight.mjs"],
    exports: ["preflightImports"],
    tests: ["tests/unit/import-preflight.test.mjs"],
    // 只由发布脚本调（设计如此：重启前的闸）；别按"运行时没接线"算缺陷
    callSites: ["scripts/release-restart.mjs"],
    allowScriptOnly: true,
    // 第 5 类开关（CLI 参数）：排障时跳过预检。证据里会写明它不是那四类。
    switches: [{ kind: "flag", flag: "--skip-import-preflight" }],
  },
];

export const CAPABILITY_IDS = CAPABILITIES.map((c) => c.id);
