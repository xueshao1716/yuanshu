// ===== brain-auto.mjs —— 脑区自调（2026-11-02）=====
//
// 依据：能力画像里的成功率 / 回退率 + 交付门判决，小步调整脑区权重。
// 纪律（缺一条就变成"随机漂移"）：
//   ① 每次单区最多 ±0.05，一轮最多调 2 个区
//   ② 硬边界 [0.2, 0.95]，永不 0 或 1
//   ③ 同一区 12 小时内只调一次；样本 < 6 不动
//   ④ 每次调整写一条 observation 事件（可追溯、可回滚）
//   ⑤ 全局开关：记忆/运行时/脑区自动.json 里 {"on": false} 立刻停
import fs from "node:fs";
import path from "node:path";
import { readRegions, writeRegions } from "./brain-regions.mjs";
import { readEvents, appendEvent } from "./evolution/index.mjs";

const AUTO_REL = path.join("记忆", "运行时", "脑区自动.json");
const MIN_N = 6;
const STEP = 0.05;
const LOW = 0.2;
const HIGH = 0.95;
const COOLDOWN_MS = 12 * 3600 * 1000;

const autoPath = (wsRoot) => path.join(String(wsRoot || "."), AUTO_REL);

export function readAutoState(wsRoot) {
  try {
    const doc = JSON.parse(fs.readFileSync(autoPath(wsRoot), "utf8"));
    return { on: doc.on !== false, lastAt: Number(doc.lastAt) || 0, lastByRegion: doc.lastByRegion || {} };
  } catch {
    return { on: true, lastAt: 0, lastByRegion: {} };
  }
}

export function writeAutoState(wsRoot, patch = {}) {
  const cur = readAutoState(wsRoot);
  const next = { ...cur, ...patch };
  fs.mkdirSync(path.dirname(autoPath(wsRoot)), { recursive: true });
  fs.writeFileSync(autoPath(wsRoot), JSON.stringify(next, null, 2), "utf8");
  return next;
}

const clamp = (v) => Math.min(HIGH, Math.max(LOW, Number(v)));
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * 算这一轮该怎么调（纯函数，不写盘）。
 * @returns {{assignments:boolean, perTask:{[k]:{n:number,succ:number,fail:number}}, nudges:{id:number,delta:number,why:string}[], skipped:string[]}}
 */
export function computeNudges({ events = [], weights = {}, now = Date.now(), lastByRegion = {} } = {}) {
  const perTask = {};
  for (const e of events) {
    if (!["task", "compare", "gate"].includes(e.kind)) continue;
    const tt = e.taskType || "未分类";
    const row = (perTask[tt] ||= { n: 0, succ: 0, fail: 0 });
    row.n += 1;
    const v = String(e.verdict || "");
    if (["pass", "keep", "green", "stable"].includes(v)) row.succ += 1;
    else if (["rollback", "red", "rejected"].includes(v)) row.fail += 1;
  }

  const nudges = [];
  const skipped = [];
  const push = (id, delta, why) => {
    if (!(id in weights)) { skipped.push(`${id}不存在`); return }
    if (now - (lastByRegion?.[id] || 0) < COOLDOWN_MS) { skipped.push(`${id}冷却中`); return }
    const cur = Number(weights[id] ?? 0.5);
    const next = clamp(cur + delta);
    const real = round2(next - cur);
    if (Math.abs(real) < 0.01) { skipped.push(`${id}已到边界`); return }
    nudges.push({ id, delta: real, why });
  };

  const totalN = Object.values(perTask).reduce((a, r) => a + r.n, 0);
  if (totalN < MIN_N) return { assignments: false, perTask, nudges: [], skipped: ["样本不足"] };

  for (const [tt, row] of Object.entries(perTask)) {
    if (row.n < MIN_N) continue;
    const failRate = row.fail / row.n;
    // 失败多 → 提高验证与分析的深度；成功稳 → 略微放松验证（给速度）
    if (failRate >= 0.3) {
      push("verification", STEP, `${tt} 失败率 ${(failRate * 100).toFixed(0)}%，验收更严`);
      push("analysis", STEP, `${tt} 失败率偏高，多拆一步`);
    } else if (failRate <= 0.05 && row.n >= MIN_N * 2) {
      push("verification", -STEP, `${tt} 连续稳定，放宽验收换速度`);
    }
  }

  // 一轮最多 2 个，且优先验证
  const picked = nudges.slice(0, 2);
  return { assignments: picked.length > 0, perTask, nudges: picked, skipped };
}

/** 应用一轮自调：写脑区 + 写 observation 事件（可追溯）。 */
export function applyNudges(wsRoot, { now = Date.now() } = {}) {
  const st = readAutoState(wsRoot);
  if (!st.on) return { ok: true, applied: [], skipped: ["自调已关闭"] };
  const events = readEvents(wsRoot, { limit: 800 });
  const { weights } = readRegions(wsRoot);
  const plan = computeNudges({ events, weights, now, lastByRegion: st.lastByRegion });
  if (!plan.nudges.length) return { ok: true, applied: [], skipped: plan.skipped, perTask: plan.perTask };

  const patch = {};
  const lastByRegion = { ...st.lastByRegion };
  for (const n of plan.nudges) { patch[n.id] = round2(clamp(Number(weights[n.id]) + n.delta)); lastByRegion[n.id] = now }
  const w = writeRegions(wsRoot, patch, { now });
  if (!w.ok) return { ok: false, error: w.error };
  writeAutoState(wsRoot, { lastAt: now, lastByRegion });
  for (const n of plan.nudges) {
    try {
      appendEvent(wsRoot, {
        kind: "observation", target: "brain", targetId: n.id,
        verdict: n.delta > 0 ? "raised" : "lowered", n: 1, by: "brain-auto",
        meta: { delta: n.delta, why: n.why, from: Number(weights[n.id]), to: patch[n.id] },
      });
    } catch {}
  }
  return { ok: true, applied: plan.nudges, perTask: plan.perTask, weights: w.weights };
}
