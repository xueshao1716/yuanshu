// ===== proactive.mjs —— 主动能力三件套（2026-11-02）=====
//
// 借 dsh-proactive 的三件事，落到元枢自己的链路上（不装 DSH 插件）：
//   ① 每日主动预算：一天最多主动找你几次，超了就不打扰
//   ② 冷会话唤醒：某个会话挂了很久没人说话 → 主动问一句
//   ③ 抖动：定时触发加 ±ratio 的随机偏移，避免整点扎堆
import fs from "node:fs";
import path from "node:path";

export const BUDGET_REL = path.join("记忆", "运行时", "主动预算.json");

export function budgetFile(wsRoot) {
  return path.join(String(wsRoot || "."), BUDGET_REL);
}

/** 给一个间隔加抖动：返回 [-ratio, +ratio] 内的随机偏移后的毫秒数。 */
export function withJitter(ms, { ratio = 0.05, rand = Math.random } = {}) {
  const base = Math.max(0, Number(ms) || 0);
  if (!base) return 0;
  const spread = base * Math.min(0.5, Math.max(0, Number(ratio) || 0));
  return Math.max(0, Math.round(base + (rand() * 2 - 1) * spread));
}

/** 读当天预算用量。 */
export function readBudget(wsRoot, day, { cap = 3 } = {}) {
  try {
    const doc = JSON.parse(fs.readFileSync(budgetFile(wsRoot), "utf8"));
    const used = Number(doc?.days?.[day] || 0);
    return { used, cap: Number(doc?.cap || cap), remaining: Math.max(0, Number(doc?.cap || cap) - used) };
  } catch {
    return { used: 0, cap, remaining: cap };
  }
}

/** 花掉一次预算；满了返回 ok:false（不写盘）。 */
export function spendBudget(wsRoot, day, { cap = 3, kind = "", now = Date.now() } = {}) {
  const cur = readBudget(wsRoot, day, { cap });
  if (cur.used >= cur.cap) return { ok: false, reason: "今天已经打扰够了", used: cur.used, cap: cur.cap };
  const days = (() => {
    try { return JSON.parse(fs.readFileSync(budgetFile(wsRoot), "utf8"))?.days || {} } catch { return {} }
  })();
  days[day] = cur.used + 1;
  // 只留最近 14 天
  for (const k of Object.keys(days)) if (k < day && Object.keys(days).length > 14) delete days[k];
  try {
    fs.mkdirSync(path.dirname(budgetFile(wsRoot)), { recursive: true });
    fs.writeFileSync(budgetFile(wsRoot), JSON.stringify({ cap: cur.cap, days, updatedAt: now }, null, 2), "utf8");
    return { ok: true, used: days[day], cap: cur.cap, kind };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/**
 * 挑一个「冷会话」：最后更新时间早于 idleMs，且不是当前会话、不是探针类。
 * @returns {{session:object, idleMs:number}|null}
 */
export function pickColdSession(sessions = [], { idleMs = 3 * 60 * 60 * 1000, now = Date.now(), skipId = "", noise = /(探针|验证|诊断|测试|probe|bench)/i } = {}) {
  let best = null;
  for (const s of sessions) {
    const id = String(s?.id || "");
    const name = String(s?.name || "");
    if (!id || id === skipId) continue;
    if (noise.test(name)) continue;
    const t = Date.parse(String(s?.updatedAt || s?.createdAt || ""));
    if (!Number.isFinite(t)) continue;
    const idle = now - t;
    if (idle < idleMs) continue;
    if (!best || idle > best.idleMs) best = { session: s, idleMs: idle };
  }
  return best;
}

/** 免打扰：0–7 点不主动。 */
export function isQuietHours(now = Date.now()) {
  const h = new Date(now).getHours();
  return h >= 0 && h < 7;
}
