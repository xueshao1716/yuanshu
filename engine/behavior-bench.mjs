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
    results.push(scored);
    try { onCase?.(scored) } catch {}
  }
  const passed = results.filter((r) => r.pass).length;
  return {
    total: results.length,
    passed,
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
  const verdict = regressions.length ? "worse" : delta > 0 ? "better" : delta < 0 ? "worse" : "same";
  return {
    ok: true,
    verdict,
    delta,
    beforeScore: before.score,
    afterScore: after.score,
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
