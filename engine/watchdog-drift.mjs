// ===== watchdog-drift.mjs —— 看门狗升级：从"进程活着"到"有没有跑偏"（2026-11-02）=====
//
// 来源：DSH Super-agent 的 Watchdog——很多故障不是进程死了，而是 LLM 循环死锁或偏离目标。
// 这里只做判断（纯函数），不杀进程、不改行为；结果落台账，需要时再让人看。
import fs from "node:fs";
import path from "node:path";

export function detectDrift(rows = [], { now = Date.now(), windowMs = 30 * 60 * 1000, repeatLimit = 5, failLimit = 3 } = {}) {
  const since = now - windowMs;
  const win = (Array.isArray(rows) ? rows : []).filter((r) => {
    const t = Number(r?.at || r?.ts || 0);
    return Number.isFinite(t) && t >= since;
  });
  const issues = [];

  // ① 空转：同一个工具 + 同一组参数反复调用
  const byKey = new Map();
  for (const r of win) {
    const k = `${r.tool || "?"}|${r.argsHash || ""}`;
    byKey.set(k, (byKey.get(k) || 0) + 1);
  }
  for (const [k, n] of byKey) {
    if (n >= repeatLimit) issues.push({ code: "loop", detail: `${k.split("|")[0]} 同参数重复 ${n} 次`, n });
  }

  // ② 连续失败：同一工具反复报错
  const fails = new Map();
  for (const r of win) {
    if (r.ok === false || /error|失败|denied/i.test(String(r.resultPreview || ""))) {
      fails.set(r.tool || "?", (fails.get(r.tool || "?") || 0) + 1);
    }
  }
  for (const [tool, n] of fails) {
    if (n >= failLimit) issues.push({ code: "failing", detail: `${tool} 连续失败 ${n} 次`, n });
  }

  // ③ 只动不改：写了一堆文件却没有一次交付判定（可能在做无用功）
  const writes = win.filter((r) => ["write", "edit"].includes(String(r.tool || ""))).length;
  const gates = win.filter((r) => String(r.tool || "") === "delivery_check").length;
  if (writes >= 6 && gates === 0) issues.push({ code: "no_gate", detail: `改了 ${writes} 次却没过一次交付门`, n: writes });

  return { drift: issues.length > 0, issues, stats: { calls: win.length, writes, gates, windowMin: Math.round(windowMs / 60000) } };
}

/** 落台账（一行一次判定，便于回看"什么时候开始偏"）。 */
export function recordDriftCheck(wsRoot, result, { now = Date.now() } = {}) {
  try {
    const dir = path.join(String(wsRoot || "."), "记忆", "运行时");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "看门狗.jsonl"), JSON.stringify({ at: now, ...result }) + "\n", "utf8");
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}

/** 最近的判定（给界面/接口用）。 */
export function recentDrift(wsRoot, limit = 20) {
  try {
    const file = path.join(String(wsRoot || "."), "记忆", "运行时", "看门狗.jsonl");
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean).slice(-limit).reverse();
  } catch { return [] }
}
