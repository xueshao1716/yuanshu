// ===== promise-runner.mjs —— 承诺到点自动干活（2026-10-28）=====
//
// 用户说：「真正的主动应该是——你说过周五给我周报，到周四晚上它自己开工、做完推给你」。
//
// 元枢原来只有「承诺台账」（记下来、到点提醒人去问），没有「到点自己干」。
// 这一层补上最后一段：
//   到期的承诺 → 真的去执行（同一个 agent 通道）→ 结果从 outbound 推出去 → 记账。
//
// 红线：**失败要说**。跑挂了也要推一条「这件事没做成，原因是…」，绝不静默。
import fs from "node:fs";
import { loadPromises, closePromise, promisePaths } from "./promises.mjs";

// 2026-10-28 真机：账本里躺着 199 条老承诺，其中几十条 due 在几天前。
// 不设上限的话，定时器会一条条把陈年旧账拿去跑——烧钱且没意义。
export const MAX_DUE_AGE_MS = 24 * 3600 * 1000;   // 过期超过一天就不再补跑
export const RUN_TIMEOUT_MS = 150_000;            // 单条执行上限
export const STUCK_AFTER_MS = 20 * 60 * 1000;     // started 超过这么久视为卡死

/** 到点该干的：pending、有 due、due 已过、且还没执行过。 */
export function duePromises({ wsRoot, now = new Date(), limit = 3 } = {}) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  // 2026-10-28：loadPromises 返回的是**数组**（老账本可能是对象，它内部已归一）
  return loadPromises(wsRoot)
    .filter((p) => p.status === "pending" && p.due && !p.firedAt)
    .filter((p) => {
      const d = Date.parse(p.due);
      if (!Number.isFinite(d) || d > t) return false;
      return t - d <= MAX_DUE_AGE_MS;   // 太旧的账不补跑（由 reapStuck/obsolete 收尾）
    })
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due))
    .slice(0, Math.max(1, limit));
}

/**
 * 收尾：把"卡住的 started"和"过期太久没跑"的承诺落成 missed/obsolete。
 * 不这么做的话，板子上会永远挂着几条 started，看着像在跑其实早死了。
 */
export function reapPromises({ wsRoot, now = new Date(), stuckAfterMs = STUCK_AFTER_MS, maxAgeMs = MAX_DUE_AGE_MS } = {}) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const file = promisePaths(wsRoot).file;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return { reaped: 0 } }
  const list = Array.isArray(raw) ? raw : Object.values(raw || {});
  let reaped = 0;
  for (const it of list) {
    if (!it || it.status !== "pending") continue;
    const startedAt = it.firedAt ? Date.parse(it.firedAt) : 0;
    // 卡在 started
    if (it.firedPhase === "started" && startedAt && t - startedAt > stuckAfterMs) {
      it.status = "missed";
      it.closedAt = new Date(t).toISOString();
      it.evidence = null;
      it.firedError = "执行中断或超时（进程重启/模型长时间无响应）";
      reaped += 1;
      continue;
    }
    // 过期太久
    const due = it.due ? Date.parse(it.due) : 0;
    if (due && t - due > maxAgeMs && !it.firedAt) {
      it.status = "obsolete";
      it.closedAt = new Date(t).toISOString();
      reaped += 1;
    }
  }
  if (reaped) { try { fs.writeFileSync(file, JSON.stringify(list, null, 2), "utf8") } catch {} }
  return { reaped };
}

/** 写执行痕迹（firedAt / firedPhase），不动状态机。 */
export function markFired(wsRoot, id, { phase = "started", now = new Date(), ms = 0, error = "" } = {}) {
  const file = promisePaths(wsRoot).file;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return { ok: false } }
  // 兼容两种历史形态：数组 / 以序号为键的对象
  const list = Array.isArray(raw) ? raw : Object.values(raw || {});
  const it = list.find((x) => x && x.id === id);
  if (!it) return { ok: false };
  if (phase === "started") it.firedAt = new Date(now).toISOString();
  it.firedPhase = phase;
  if (ms) it.firedMs = ms;
  if (error) it.firedError = String(error).slice(0, 200);
  try { fs.writeFileSync(file, JSON.stringify(list, null, 2), "utf8") } catch { return { ok: false } }
  return { ok: true };
}

/**
 * 跑一批到期的承诺。
 * @param {{wsRoot:string, run:(text:string)=>Promise<string>, send:(payload:object)=>Promise<any>,
 *          now?:Date, limit?:number, log?:Function}} p
 */
export async function runDuePromises({ wsRoot, run, send, now = new Date(), limit = 3, log = () => {} } = {}) {
  const due = duePromises({ wsRoot, now, limit });
  const results = [];
  let fired = 0;
  let failed = 0;

  for (const p of due) {
    const startedAt = Date.now();
    // 先标 started，避免"跑得慢"时被下一轮重复执行
    try { markFired(wsRoot, p.id, { phase: "started", now }) } catch {}
    try {
      // 2026-11-03 real-machine: the race timeout timer was never cleared, so it
      // held the process open for the full 150s (unit test killed by SIGTERM).
      let timer;
      try {
        const answer = String((await Promise.race([
          run(p.text),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("执行超时")), RUN_TIMEOUT_MS); }),
        ])) || "").slice(0, 1500);
        await send({ text: `到点了，这件事我去做了：${p.text}\n\n${answer}`.trim(), channel: "wechat" });
        closePromise(wsRoot, p.id, { status: "kept", evidence: { via: "promise-runner", answer: answer.slice(0, 400) }, now });
        try { markFired(wsRoot, p.id, { phase: "done", now: new Date(), ms: Date.now() - startedAt }) } catch {}
        fired += 1;
      } finally { clearTimeout(timer); }
      results.push({ id: p.id, ok: true, ms: Date.now() - startedAt });
      log(`[承诺] 已完成：${String(p.text).slice(0, 40)}`);
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 200);
      failed += 1;
      try { await send({ text: `到点了，这件事我没做成：${p.text}\n原因：${msg}`, channel: "wechat" }) } catch {}
      closePromise(wsRoot, p.id, { status: "missed", evidence: { via: "promise-runner", error: msg }, now });
      try { markFired(wsRoot, p.id, { phase: "failed", now: new Date(), error: msg }) } catch {}
      results.push({ id: p.id, ok: false, error: msg });
      log(`[承诺] 没做成：${String(p.text).slice(0, 40)}（${msg}）`);
    }
  }

  return { fired, failed, results };
}
