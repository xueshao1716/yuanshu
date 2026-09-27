// ===== activity-rhythm.mjs —— 从真实时间戳观测"作息"与"节律" =====
//
// 为什么需要它：promptTimeText 只说"现在几点"和"距上次对话多久"。但时间观念还有一层——
// **对这个人来说，现在算不算正常时间**。凌晨 3 点说"早上好"和上午 10 点说"早上好"，
// 是完全不同的两件事。要判断这个，就必须先真实观测到对方的作息，而不是假设朝九晚五。
//
// 数据源（都是已经落盘的真实记录，不新增埋点）：
//   ① 会话文件名 `<ISO-UTC>_<uuid>.jsonl` —— 每个会话的**真实创建时刻**，只读文件名，零解析成本
//   ② 记忆/记忆日志.md 的 `### YYYY-MM-DD HH:MM` 标题 —— 真实记忆写入时刻（跨期更长）
//
// **刻意不用 记忆/情绪感受.jsonl**：它看着最细（768 条），实际被批量任务污染——
// 2026-09-07 单日 578 条、09-06 单日 103 条（占全部 88%），且相邻记录间隔中位数正好 60 秒，
// 是定时/循环跑出来的，不是人的活动。拿它算作息会得出"3:00–9:00 全是 60 条"这种假结论。
// 换成会话文件名后分布立刻正常：03:00–08:00 为 0（在睡），峰值 23:00。
//
// 规矩与整个项目一致：**样本不够就返回 null**（不观测），由调用方渲染成"未观测"，
// 而不是编一句"你通常早睡早起"。**只读时间戳**，绝不把内容带出去。
import fs from "node:fs";
import path from "node:path";

const MIN_SAMPLES = 20;      // 少于这个数不足以谈"作息"
// 活跃时段覆盖比例。取 0.8 时，均匀分布在 10–21 点的人会被判成"10–19 活跃"——
// 把各占一成活动的 20、21 点排除在外，而它们显然属于"通常活跃"。0.9 才贴合语义。
const COVERAGE = 0.9;
const LATE_NIGHT_END = 6;    // 本地 0:00–5:59 记作深夜

function localHour(d) { return d.getHours(); }
function localDayKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 解析所有可用的时间戳；坏数据跳过，不因为一条脏数据丢掉整份作息。 */
function collectStamps(wsRoot, fsMod, sessionDir) {
  const out = [];
  // ① 会话文件名：2026-09-14T14-53-30-558Z_<uuid>.jsonl（UTC）
  if (sessionDir) {
    try {
      for (const name of fsMod.readdirSync(sessionDir)) {
        const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
        if (!m) continue;
        const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
        if (!Number.isNaN(d.getTime())) out.push(d);
      }
    } catch {}
  }
  // ② 记忆日志标题
  const log = path.join(wsRoot, "记忆", "记忆日志.md");
  try {
    const raw = fsMod.readFileSync(log, "utf8");
    for (const m of raw.matchAll(/^###\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/gm)) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
      if (!Number.isNaN(d.getTime())) out.push(d);
    }
  } catch {}
  return out;
}

/** 最小覆盖窗口：找一个尽量短的连续时段装下 COVERAGE 比例的记录（跨午夜按模 24 处理）。 */
function activeWindow(hours, total) {
  if (!total) return null;
  const need = total * COVERAGE;
  let best = null;
  for (let start = 0; start < 24; start++) {
    let acc = 0;
    for (let len = 1; len <= 24; len++) {
      acc += hours[(start + len - 1) % 24];
      if (acc >= need) {
        if (!best || len < best.len || (len === best.len && acc > best.acc)) best = { start, len, acc };
        break;
      }
    }
  }
  if (!best) return null;
  return { start: best.start, end: (best.start + best.len - 1) % 24, len: best.len, coverage: best.acc / total };
}

export function readActivityRhythm(wsRoot, { now = new Date(), days = 30, fsMod = fs, sessionDir = "" } = {}) {
  try {
    const stamps = collectStamps(wsRoot, fsMod, sessionDir);
    if (stamps.length < MIN_SAMPLES) return null;
    const nowDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const cutoff = nowDate.getTime() - days * 86400_000;
    const recent = stamps.filter((d) => d.getTime() >= cutoff && d.getTime() <= nowDate.getTime() + 60000);
    const pool = recent.length >= MIN_SAMPLES ? recent : stamps;
    if (pool.length < MIN_SAMPLES) return null;

    const hours = new Array(24).fill(0);
    for (const d of pool) hours[localHour(d)]++;
    const win = activeWindow(hours, pool.length);
    if (!win) return null;

    const todayKey = localDayKey(nowDate);
    const todayCount = pool.filter((d) => localDayKey(d) === todayKey).length;
    const lateNight = pool.filter((d) => localHour(d) < LATE_NIGHT_END).length;
    const nowHour = localHour(nowDate);
    const inWindow = win.len >= 24 || ((nowHour - win.start + 24) % 24) < win.len;
    const spanDays = Math.max(1, Math.round((nowDate.getTime() - Math.min(...pool.map((d) => d.getTime()))) / 86400_000));

    return {
      observedAt: nowDate.toISOString(),
      samples: pool.length,
      spanDays,
      hours,
      activeStart: win.start,
      activeEnd: win.end,
      coverage: Number(win.coverage.toFixed(3)),
      todayCount,
      lateNight,
      lateNightRatio: Number((lateNight / pool.length).toFixed(3)),
      nowInWindow: inWindow,
      nowHour,
      isLateNight: nowHour < LATE_NIGHT_END,
    };
  } catch { return null; }
}

const hh = (n) => `${String(n).padStart(2, "0")}:00`;

/**
 * 把作息读成一句人话。这是给模型的"时间感"增量，不是给用户看的报表——
 * 报表由台前渲染（同一份读数，两处用法）。
 */
export function rhythmPhrase(rhythm, now = new Date()) {
  if (!rhythm) return "";
  const nowDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const nowHour = nowDate.getHours();
  const win = `你通常 ${hh(rhythm.activeStart)}–${hh((rhythm.activeEnd + 1) % 24)} 活跃（近 ${rhythm.spanDays} 天 ${rhythm.samples} 条记录）`;
  const parts = [win];
  if (rhythm.isLateNight && !rhythm.nowInWindow) {
    parts.push(`现在是 ${hh(nowHour)}，属于你的深夜时段${rhythm.lateNightRatio <= 0.1 ? "（这个点你几乎不出现）" : ""}——先说清你还在忙什么，或者劝一句休息，不要当作正常工作时间`);
  } else if (!rhythm.nowInWindow) {
    parts.push(`现在是 ${hh(nowHour)}，落在你平常活跃时段之外`);
  }
  if (rhythm.todayCount > 0) parts.push(`今天已经聊过 ${rhythm.todayCount} 轮`);
  return parts.join("；");
}

export const RHYTHM_LIMITS = { MIN_SAMPLES, COVERAGE, LATE_NIGHT_END };
