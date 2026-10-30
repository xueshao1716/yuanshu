// ===== behavior-bench.mjs —— 行为题库与对照（2026-10-30）=====
//
// 为什么要有：自动补丁现在的门禁只验"代码测试过没过"，不验"她干活有没有变差"。
// 文章里 Harness² 的关键是外层对照实验：改动版和原版跑同一批任务，新版真的更好才留。
//
// 设计：
//   · 题库是数据（工作区/评测/行为题库.json），用例 = 一句输入 + 若干判定
//   · 打分是纯函数（scoreCase），可被单测；执行靠注入（executor），不绑死在某条通道上
//   · 对照是纯函数（compareRuns）：新 ≥ 旧 → keep，退化 → 列出哪几题退化
import fs from "node:fs";
import path from "node:path";

export const CASES_REL = path.join("评测", "行为题库.json");

export function casesPath(wsRoot) {
  return path.join(String(wsRoot || "."), CASES_REL);
}

export const JUDGES_REL = path.join("评测", "评分器.json");

// 2026-10-30：默认两个**不同 provider** 的评委。同一家模型自评容易互相包庇。
export const DEFAULT_JUDGES = [
  { provider: "deepseek", modelId: "deepseek-flash" },
  { provider: "agnes", modelId: "agnes-3.0-flash" },
];
export const DEFAULT_MAX_SPREAD = 0.3;

export function judgesPath(wsRoot) {
  return path.join(String(wsRoot || "."), JUDGES_REL);
}

export function loadJudges(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(judgesPath(wsRoot), "utf8"));
    const list = Array.isArray(raw?.judges) ? raw.judges : [];
    const ok = list.filter((j) => j && j.provider && j.modelId)
      .map((j) => ({ provider: String(j.provider), modelId: String(j.modelId) }));
    return { judges: ok.length ? ok : DEFAULT_JUDGES, maxSpread: Number(raw?.maxSpread) || DEFAULT_MAX_SPREAD };
  } catch {
    return { judges: DEFAULT_JUDGES, maxSpread: DEFAULT_MAX_SPREAD };
  }
}

/**
 * 聚合多个评委：得分取**最低**（保守），分歧过大标记 disagree。
 * 为什么取最低而不是平均：两个评委一个 0.9 一个 0.2，平均 0.55 看着还行，其实是有人觉得不行。
 */
export function aggregateJudges(scores = [], { maxSpread = DEFAULT_MAX_SPREAD } = {}) {
  const valid = (scores || []).filter((x) => Number.isFinite(Number(x?.score)));
  if (!valid.length) return { score: 0, reason: "没有评委给出有效分数", judges: [], spread: null, disagree: true };
  const nums = valid.map((x) => Number(x.score));
  const spread = Math.round((Math.max(...nums) - Math.min(...nums)) * 1000) / 1000;   // 去浮点毛刺（0.7000000001）
  const low = valid.reduce((a, b) => (Number(a.score) <= Number(b.score) ? a : b));
  return {
    score: Number(low.score),
    reason: String(low.reason || "").slice(0, 200),
    judges: valid.map((x) => ({ provider: x.provider || "", modelId: x.modelId || "", score: Number(x.score), reason: String(x.reason || "").slice(0, 160) })),
    spread,
    disagree: spread > maxSpread,
  };
}

export function loadCases(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(casesPath(wsRoot), "utf8"));
    const list = Array.isArray(raw?.cases) ? raw.cases : Array.isArray(raw) ? raw : [];
    return list.filter((c) => c && c.id && c.input);
  } catch { return [] }
}

/** 一条用例的判定：全部通过才算过。 */
export function scoreCase(c, result = {}) {
  const failures = [];
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls.map((x) => String(x?.name || x)) : [];
  const text = String(result.text || "");
  const checks = Array.isArray(c.checks) ? c.checks : [];

  for (const chk of checks) {
    const kind = String(chk.kind || "");
    if (kind === "tool_called") {
      if (!toolCalls.includes(String(chk.tool))) failures.push(`没调用工具 ${chk.tool}`);
    } else if (kind === "tool_not_called") {
      if (toolCalls.includes(String(chk.tool))) failures.push(`不该调用工具 ${chk.tool}`);
    } else if (kind === "any_tool_called") {
      if (!toolCalls.length) failures.push("一个工具都没调用");
    } else if (kind === "text_contains") {
      if (!text.includes(String(chk.value || ""))) failures.push(`回复里没有「${chk.value}」`);
    } else if (kind === "text_not_contains") {
      if (text.includes(String(chk.value || ""))) failures.push(`回复里不该出现「${chk.value}」`);
    } else if (kind === "judge") {
      // 2026-10-30：主观项。judge 由调用方注入（judge({rubric,answer,caseId}) → {score 0~1, reason}）。
      // 没注入就明确失败，不假装通过——"没法判"和"判过了"必须分开。
      const j = result.judges?.[chk.name || "default"];
      const min = Number(chk.min ?? 0.6);
      if (!j) failures.push(`主观判定「${chk.name || "default"}」没有结果`);
      else if (!(Number(j.score) >= min)) failures.push(`主观判定不达标（${Number(j.score).toFixed(2)} < ${min}）：${String(j.reason || "").slice(0, 60)}`);
      // 2026-10-30：评委分歧要显式暴露——不一致的判定不能悄悄算分
      else if (j.disagree && chk.failOnDisagree === true) {
        const who = (j.judges || []).map((x) => `${x.provider}:${x.score}`).join(" / ");
        failures.push(`评委分歧过大（${who}，差距 ${Number(j.spread).toFixed(2)} > ${Number(j.maxSpread ?? 0.3)}）`);
      }
    } else if (kind === "no_error") {
      if (result.error) failures.push(`有错误：${String(result.error).slice(0, 80)}`);
    } else if (kind === "max_chars") {
      const n = Number(chk.value) || 0;
      if (n && text.length > n) failures.push(`回复太长（${text.length} > ${n}）`);
    }
  }
  // 有 error 且用例没明确要求忽略 → 直接算失败
  if (result.error && !checks.some((x) => x.kind === "ignore_error")) failures.push(`执行出错：${String(result.error).slice(0, 80)}`);

  return { id: c.id, title: c.title || c.id, pass: failures.length === 0, failures };
}

/** 跑一批用例（executor 注入：({input, id}) => {text, toolCalls, error}） */
export async function runBench({ cases = [], executor, onCase = null, timeoutMs = 180_000 } = {}) {
  if (typeof executor !== "function") throw new Error("executor 必填");
  const results = [];
  for (const c of cases) {
    const started = Date.now();
    let result = {};
    try {
      const raw = await Promise.race([
        executor({ input: c.input, id: c.id }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`超时 ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)),
      ]);
      result = raw || {};
    } catch (e) {
      result = { error: String(e?.message || e) };
    }
    const scored = scoreCase(c, result);
    scored.durationMs = Date.now() - started;
    scored.usage = result.usage || null;   // { input, output, total }（执行器给多少记多少）
    scored.judges = result.judges || null; // 2026-10-30：保留每个评委的分数与理由（审计用）
    results.push(scored);
    try { onCase?.(scored) } catch {}
  }
  const passed = results.filter((r) => r.pass).length;
  const durationMs = results.reduce((a, r) => a + (Number(r.durationMs) || 0), 0);
  const tokens = results.reduce((a, r) => a + (Number(r.usage?.total) || 0), 0);
  return {
    total: results.length,
    passed,
    durationMs,
    tokens,
    score: results.length ? Math.round((passed / results.length) * 100) : 0,
    results,
    at: Date.now(),
  };
}

/** 对照：新跑 vs 旧跑。退化优先于总分（总分涨了但有题退化也要说）。 */
export function compareRuns(before, after) {
  if (!before || !after) return { ok: false, error: "缺一次跑分结果" };
  const b = new Map((before.results || []).map((r) => [r.id, r]));
  const regressions = [];
  const improvements = [];
  for (const r of after.results || []) {
    const old = b.get(r.id);
    if (!old) continue;
    if (old.pass && !r.pass) regressions.push({ id: r.id, title: r.title, failures: r.failures });
    if (!old.pass && r.pass) improvements.push({ id: r.id, title: r.title });
  }
  const delta = (after.score || 0) - (before.score || 0);
  const beforeMs = Number(before.durationMs) || 0, afterMs = Number(after.durationMs) || 0;
  const beforeTok = Number(before.tokens) || 0, afterTok = Number(after.tokens) || 0;
  const verdict = regressions.length ? "worse" : delta > 0 ? "better" : delta < 0 ? "worse" : "same";
  return {
    ok: true,
    verdict,
    delta,
    beforeScore: before.score,
    afterScore: after.score,
    durationMs: { before: beforeMs, after: afterMs, delta: afterMs - beforeMs },
    tokens: { before: beforeTok, after: afterTok, delta: afterTok - beforeTok },
    regressions,
    improvements,
    // 给人看的一句话
    summary: regressions.length
      ? `退化 ${regressions.length} 题：${regressions.map((r) => r.title).join("、")}`
      : delta > 0
        ? `变好了（${before.score}% → ${after.score}%）`
        : delta < 0
          ? `总分降了（${before.score}% → ${after.score}%）`
          : `没有变化（${after.score}%）`,
  };
}

/** 存一次跑分（按时间命名，方便对照） */
export function saveRun(wsRoot, run, { tag = "run" } = {}) {
  const dir = path.join(String(wsRoot || "."), "评测", "跑分");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${tag}-${new Date(run.at || Date.now()).toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(run, null, 2), "utf8");
  return path.join(dir, name);
}

export function listRuns(wsRoot, { limit = 20 } = {}) {
  const dir = path.join(String(wsRoot || "."), "评测", "跑分");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit)
      .map((f) => ({ name: f, path: path.join(dir, f) }));
  } catch { return [] }
}
