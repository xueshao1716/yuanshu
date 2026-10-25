// ===== capability-plan.mjs —— accepted 之后自动产出「改动计划 + 测试骨架」（2026-10-26）=====
//
// 上一版的短板：提案 accept 之后还是要人肉从零写代码。
// 这一步把"我记下要做什么"变成"我准备好了要做什么"：
//   · PLAN.md   —— 改哪、怎么改、先改哪、什么算完成、风险在哪
//   · 测试骨架  —— 可运行的 node:test 文件（全部 `test.todo`，不假装通过）
//
// 三条硬规矩：
//   1. **绝不覆盖已存在的测试文件**——那是别人的地基，不是我的空地；
//   2. 骨架必须语法合法（写完立刻 node --check，不过就删掉报错）；
//   3. PLAN 里必须能点回证据（entryId / feedbackId / job reason），不许只有形容词。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const PLAN_DIR = path.join("记忆", "运行时", "能力提案");

/** 每个领域该动哪些文件、怎么验——写在这里，而不是每次让模型现编。 */
export const AREA_PLAYBOOK = {
  audio: {
    files: ["engine/output-qa.mjs", "tests/unit/output-qa.test.mjs"],
    hook: "checkOutput() / measureLoudness()",
    testFile: "output-qa-fix",
    verify: "拿一条真实导出跑 output_check，断言 LUFS/真峰值/音画差在阈值内",
  },
  knowledge: {
    files: ["engine/knowledge-enrich.mjs", "engine/knowledge-commit.mjs", "tests/unit/knowledge-enrich.test.mjs"],
    hook: "enrichEntry() / commit()",
    testFile: "knowledge-fix",
    verify: "造带已知 claim 的样本，断言 claimType/expiresAt 正确且 entries() 校验通过",
  },
  feedback: {
    files: ["engine/crash-triage.mjs", "engine/telemetry.mjs", "tests/unit/crash-triage.test.mjs"],
    hook: "triageReport() / collectIncidents()",
    testFile: "feedback-fix",
    verify: "造一条缺构建号的报告，断言研判为 no_build 且回信含「要补什么」",
  },
  shell: {
    files: ["scripts/", "engine/tools/unified-tools.mjs"],
    hook: "pwsh 工具 / 脚本入口",
    testFile: "shell-encoding-fix",
    verify: "写一个含中文的脚本跑一遍，断言输出无乱码（对比 UTF-8 字节）",
  },
  deploy: {
    files: ["scripts/release-restart.mjs", "watchdog.cjs", "tests/unit/release-restart.test.mjs"],
    hook: "release-restart / watchdog 退避",
    testFile: "deploy-fix",
    verify: "连续两次 release-restart，断言端口释放、health 200、只有一份实例",
  },
  mcp: {
    files: ["engine/mcp-client.mjs", "engine/feedback-relay.mjs"],
    hook: "连接超时与降级",
    testFile: "mcp-degrade-fix",
    verify: "断网场景调一次外部工具，断言超时后降级而不是挂死",
  },
  render: {
    files: ["server.mjs", "engine/detached-run.mjs", "engine/job-state.mjs"],
    hook: "脱链渲染作业的失败回报 / 重试",
    testFile: "render-job-fix",
    verify: "起一个会失败的渲染作业，断言失败被记账、有 reason、且不会无限重试",
  },
  general: {
    files: ["server.mjs"],
    hook: "待定位",
    testFile: "general-fix",
    verify: "补一条能复现该现象的最小测试",
  },
};

/**
 * 文件名只允许 ASCII：中文文件名在 Windows/Linux 之间、在命令行与测试串里都会出事
 * （真机：生成过 tests/unit/作业-小语宣传片-….test.mjs，立刻改掉）。
 * 保留英文词，其它用领域名 + 短哈希兜底。
 */
export function slugOf(title, { area = "general", id = "" } = {}) {
  const ascii = String(title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .toLowerCase();
  const words = ascii.split("-").filter((w) => w.length > 1);
  const base = words.slice(0, 5).join("-");
  if (base.length >= 4) return `${base}-fix`;
  const tail = String(id || "").replace(/[^a-z0-9]/gi, "").slice(0, 6) || "0000";
  return `${area}-fix-${tail}`;
}

/** 生成计划（纯函数，不写盘）。 */
export function planFor(proposal = {}, { now = Date.now() } = {}) {
  const area = AREA_PLAYBOOK[proposal.area] ? proposal.area : "general";
  const pb = AREA_PLAYBOOK[area];
  const slug = slugOf(proposal.title, { area, id: proposal.id });
  const evidenceLines = (proposal.evidence || []).slice(0, 6).map(
    (e) => `- ${e.source}${e.id ? ` · \`${String(e.id).slice(0, 16)}\`` : ""}${e.at ? ` · ${new Date(e.at).toISOString().slice(0, 16)}` : ""}`,
  );
  const steps = [
    `先在测试里复现：新建 \`tests/unit/${slug}.test.mjs\`（骨架已生成），把 "复现" 那条 todo 换成能失败的真实断言。`,
    `改 \`${pb.files[0]}\`：入口是 ${pb.hook}。只动这一处，别顺手重构。`,
    `跑 \`node --test tests/unit/${slug}.test.mjs\`，红了再改代码，绿了再跑全量 \`npm test\`。`,
    `交付前按 \`output_check\` / 相关门禁过一遍（见下方验收）。`,
    `发布后回填 \`POST /api/capability/mark\`：state=shipped + version + commit + test，缺一样会被拒。`,
  ];
  const plan = {
    id: proposal.id,
    title: proposal.title,
    area,
    areaLabel: proposal.areaLabel || area,
    createdAt: now,
    severity: proposal.severity,
    recurrence: proposal.recurrence || 1,
    symptom: proposal.symptom || "",
    files: pb.files,
    focusHook: pb.hook,
    testFile: `tests/unit/${slug}.test.mjs`,
    accept: pb.verify,
    steps,
    risks: [
      "别在修这个问题时顺手改别的（改动面越大，回滚越难）",
      "如果复现不了，先补证据再动手——不要盲改",
      "改完必须留下能复现的测试，否则下次它还会回来",
    ],
    evidence: evidenceLines,
    markdown: "",
  };
  // markdown 在这里就算好——调用方（接口/测试）拿到即用，不用再记得调 renderMarkdown
  plan.markdown = renderMarkdown(plan);
  return plan;
}

function renderMarkdown(plan) {
  return [
    `# ${plan.title}`,
    "",
    `- 领域：${plan.areaLabel}（\`${plan.area}\`）`,
    `- 严重度：${plan.severity} · 同类出现 ${plan.recurrence} 次`,
    `- 生成时间：${new Date(plan.createdAt).toISOString()}`,
    plan.symptom ? `- 症状：${plan.symptom}` : "",
    "",
    "## 证据（能点回去）",
    "",
    ...(plan.evidence.length ? plan.evidence : ["- （没有留证据——请先补，再动手）"]),
    "",
    "## 动哪",
    "",
    ...plan.files.map((f) => `- \`${f}\``),
    `- 入口：${plan.focusHook}`,
    "",
    "## 怎么做",
    "",
    ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## 什么算完成",
    "",
    `- ${plan.accept}`,
    `- 测试文件：\`${plan.testFile}\`（现在全部是 \`test.todo\`，不是"通过"）`,
    "",
    "## 风险",
    "",
    ...plan.risks.map((r) => `- ${r}`),
    "",
  ].filter((x) => x !== "").join("\n");
}

/** 测试骨架：全部 todo，保证套件仍是绿的（红着进主干是最坏的做法）。 */
export function testSkeleton(plan) {
  return `// ${plan.title}
// 由 capability-plan 生成（${new Date(plan.createdAt).toISOString()}）——**全部是 todo，不是通过**
// 用法：把 todo 逐条换成真实断言，红了再改代码。
import { test } from "node:test";

test("复现：${plan.symptom.slice(0, 50).replace(/"/g, "'")}", (t) => {
  t.todo("用最小输入复现这个问题，先让它红");
});

test("修复后：不再复现", (t) => {
  t.todo("同一输入下断言不再出现该症状");
});

test("回归：相邻行为没被改坏", (t) => {
  t.todo("补一条与 ${plan.area} 相邻的既有行为断言");
});

// 参考验收：${plan.accept}
`;
}

/**
 * 落地：写 PLAN.md 与测试骨架（不覆盖已有测试）。写完立刻校验语法。
 * @returns {{ok:boolean, planPath?:string, testPath?:string, skippedTest?:boolean, error?:string}}
 */
export function materializeProposal(wsRoot, proposal, { now = Date.now() } = {}) {
  const root = String(wsRoot || ".");
  const plan = planFor(proposal, { now });
  plan.markdown = renderMarkdown(plan);
  const dir = path.join(root, PLAN_DIR, String(proposal.id || "unknown"));
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, "PLAN.md");
  fs.writeFileSync(planPath, plan.markdown, "utf8");

  // 测试骨架：仓库根目录（server.mjs 所在）下的 tests/unit
  const repoRoot = process.cwd().endsWith("pi-web") ? process.cwd() : path.resolve(root, "..", "pi-web");
  const testPath = path.join(repoRoot, plan.testFile);
  if (fs.existsSync(testPath)) {
    return { ok: true, planPath, testPath, skippedTest: true };
  }
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, testSkeleton(plan), "utf8");
  try {
    execFileSync(process.execPath, ["--check", testPath], { stdio: "pipe", timeout: 20000 });
  } catch (e) {
    fs.rmSync(testPath, { force: true });
    return { ok: false, planPath, error: `骨架语法不合法，已删除：${String(e?.stderr || e).slice(0, 120)}` };
  }
  return { ok: true, planPath, testPath };
}
