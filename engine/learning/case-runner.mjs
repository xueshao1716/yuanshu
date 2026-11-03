// ===== case-runner.mjs —— 跑封存用例并记结果（M2 最后一段，2026-11-03）=====
//
// 分工：
//   · 本模块负责：并发跑用例、超时、汇总、落盘（按 skill+version）
//   · 谁来执行单条用例，由注入的 runCase 决定（她/测试/人工）
// 结果落 记忆/进化/结果/<skill>/<version>.json，供 compare 直接读取。
import fs from "node:fs";
import path from "node:path";
import { loadSealed } from "./sealed-cases.mjs";

export function resultsPath(wsRoot, skill, version) {
  const safe = (s) => String(s || "").replace(/[\\/:*?"<>|]/g, "_");
  return path.join(String(wsRoot || "."), "记忆", "进化", "结果", safe(skill), `${safe(version)}.json`);
}

/**
 * 跑一批用例。
 * @param {{cases:Array, runCase:(c:any)=>Promise<{ok:boolean, detail?:any}>, concurrency?:number, timeoutMs?:number}} opts
 */
export async function runCases({ cases = [], runCase, concurrency = 2, timeoutMs = 120000 } = {}) {
  if (typeof runCase !== "function") return { ok: false, reason: "没有 runCase 执行器" };
  const list = Array.isArray(cases) ? cases : [];
  if (!list.length) return { ok: false, reason: "用例为空" };

  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const c = list[cursor++];
      const started = Date.now();
      try {
        const r = await Promise.race([
          runCase(c),
          new Promise((_, rej) => setTimeout(() => rej(new Error("单例超时")), timeoutMs)),
        ]);
        results.push({ id: String(c.id), ok: !!r?.ok, ms: Date.now() - started, detail: r?.detail ?? null });
      } catch (e) {
        results.push({ id: String(c.id), ok: false, ms: Date.now() - started, error: String(e?.message || e).slice(0, 120) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  results.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, total: results.length, passed: results.filter((r) => r.ok).length, results };
}

/** 把结果落盘（同 skill+version 覆盖写）。 */
export function saveResults(wsRoot, { skill, version, results = [], at = new Date().toISOString() } = {}) {
  if (!skill || !version) return { ok: false, error: "缺 skill 或 version" };
  const file = resultsPath(wsRoot, skill, version);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ skill, version, at, results }, null, 2), "utf8");
    return { ok: true, file, count: results.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

export function loadResults(wsRoot, skill, version) {
  try {
    return JSON.parse(fs.readFileSync(resultsPath(wsRoot, skill, version), "utf8"));
  } catch { return null }
}

/** 用封存用例 + 一个执行器跑一轮并落盘（版本名自定，如 baseline / candidate-1）。 */
export async function runAndSave(wsRoot, { skill, version, runCase, concurrency = 2, timeoutMs = 120000 } = {}) {
  const sealed = loadSealed(wsRoot, skill);
  if (!sealed.ok) return { ok: false, reason: sealed.error };
  const out = await runCases({ cases: sealed.cases, runCase, concurrency, timeoutMs });
  if (!out.ok) return out;
  const saved = saveResults(wsRoot, { skill, version, results: out.results });
  return { ...out, saved: saved.ok, file: saved.file, version, skill };
}
