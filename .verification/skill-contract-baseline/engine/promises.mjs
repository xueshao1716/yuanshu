// ===== promises.mjs —— 承诺兑现：把"我回头给你"这种话变成可追踪的账 =====
//
// 为什么需要它：模型最廉价的讨好方式就是承诺——"下次给你补上""回头我再改"。
// 说完就滑过去了，下一轮它自己也不记得，于是承诺变成一种**不被观测的说法**。
// 这个模块把承诺落成账：提取 → 存下 → 到期提醒 → 由人（或证据）结清。
//
// 两条硬规矩：
//   ① **绝不自动标记"已兑现"**。结清只能来自显式调用（台前按钮或明确证据）。
//      自动判定"大概做了吧"正是这个项目在治的病。
//   ② 只提取**助手自己**的延迟承诺，且必须是真实承诺句。宁可漏，不可灌水——
//      提取错一次，账本就成了噪音，人就不看了。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "./atomic-io.mjs";

const STORE = "承诺兑现.json";
const MAX_RECORDS = 200;
const DUE_HINTS = { 明天: 1, 后天: 2 };

export function promisePaths(wsRoot) {
  return { dir: path.join(wsRoot, "记忆"), file: path.join(wsRoot, "记忆", STORE) };
}

/** 去重键：按要点前 40 字比对，避免同一句承诺每轮重复入库。 */
function keyOf(text) {
  return String(text || "").replace(/\s+/g, "").slice(0, 40);
}

/**
 * 从助手回复里提取延迟承诺（纯函数，可单测）。
 * 只认"时间词 + 我来做"的句式；条件句、否定句、给用户的建议一律不认。
 */
export function extractPromises(assistText, { at = new Date(), sessionId = "" } = {}) {
  const raw = String(assistText || "");
  if (!raw.trim()) return [];
  const atDate = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  const found = [];
  const patterns = [
    // ① "我 + 时间词 + 动作"：主语明确
    /我(明天|后天|下次|回头|稍后|待会|待会儿|一会儿|晚点|之后)([^\n。；;]{4,60})/g,
    // ② "时间词 + 我 + 动作"：主语同样明确。
    //    刻意**不认**"下次再重新检查一遍配置比较好"这类没有主语的句子——那是在给用户建议，
    //    不是助手自己担责；混进来一次，账本就成了噪音。
    /(?:^|[。；;！!？?\s])(明天|后天|下次|回头|稍后|待会|待会儿|一会儿|晚点|之后)我([^\n。；;]{4,60})/g,
  ];
  for (const re of patterns) {
    for (const m of raw.matchAll(re)) {
      const when = m[1];
      const tail = String(m[2] || "").trim();
      if (!tail) continue;
      // 否定 = 决定，不是承诺
      if (/^(?:不|没|别|不用|不再)/.test(tail)) continue;
      // 条件句不是承诺
      const window = raw.slice(Math.max(0, m.index - 12), m.index + m[0].length);
      if (/如果|假如|要是|万一|除非/.test(window)) continue;
      // "我建议你下次…" 之类是在给用户建议，不是自己担责
      const lead = raw.slice(Math.max(0, m.index - 6), m.index);
      if (/建议|推荐|你可以|你可以先|不如你/.test(lead)) continue;
      const text = `${when}${tail}`.replace(/\s+/g, " ").slice(0, 120);
      // 整理类/格式类的"之后"常常是叙述顺序而非承诺，去掉明显的过程连接词开头
      if (/^(?:之后|下次)(?:我)?(?:再)?(?:说|讲|看情况)/.test(text)) continue;
      const days = DUE_HINTS[when];
      const due = days ? new Date(atDate.getTime() + days * 86400_000).toISOString() : null;
      found.push({
        id: `p_${atDate.getTime().toString(36)}_${found.length}`,
        at: atDate.toISOString(),
        sessionId: String(sessionId || "").slice(0, 64),
        text,
        due,
        status: "pending",
        evidence: null,
        closedAt: null,
      });
    }
  }
  // 同一轮里重复命中同一件事只留一条
  const seen = new Set();
  return found.filter((p) => {
    const k = keyOf(p.text);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function loadPromises(wsRoot, fsMod = fs) {
  try {
    const f = promisePaths(wsRoot).file;
    if (!fsMod.existsSync(f)) return [];
    const parsed = JSON.parse(fsMod.readFileSync(f, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((p) => p && typeof p === "object" && p.text) : [];
  } catch { return []; }
}

function savePromises(wsRoot, list, fsMod = fs) {
  try {
    fsMod.mkdirSync(promisePaths(wsRoot).dir, { recursive: true });
    // 超限时优先丢弃已结清的旧账，绝不丢还挂着的 pending
    let next = list;
    if (next.length > MAX_RECORDS) {
      const closed = next.filter((p) => p.status !== "pending");
      const open = next.filter((p) => p.status === "pending");
      const room = Math.max(0, MAX_RECORDS - open.length);
      next = [...closed.slice(-room), ...open].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }
    atomicWriteText(promisePaths(wsRoot).file, JSON.stringify(next, null, 2));
    return { ok: true, count: next.length };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

/** 收录本轮的承诺；同要点已在账上（任意状态）就不再重复记。 */
export function recordPromises(wsRoot, list, fsMod = fs) {
  try {
    const incoming = Array.isArray(list) ? list : [];
    if (!incoming.length) return { ok: true, added: 0 };
    const existing = loadPromises(wsRoot, fsMod);
    const known = new Set(existing.map((p) => keyOf(p.text)));
    const added = incoming.filter((p) => !known.has(keyOf(p.text)));
    if (!added.length) return { ok: true, added: 0 };
    savePromises(wsRoot, [...existing, ...added], fsMod);
    return { ok: true, added: added.length };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

/** 结清/作废。**必须显式调用**——本模块没有任何自动结清路径。 */
export function closePromise(wsRoot, id, { status = "kept", evidence = null, now = new Date() } = {}, fsMod = fs) {
  try {
    if (!["kept", "dropped"].includes(status)) return { ok: false, reason: "状态只能是 kept 或 dropped" };
    const list = loadPromises(wsRoot, fsMod);
    const hit = list.find((p) => p.id === id);
    if (!hit) return { ok: false, reason: "承诺不存在" };
    hit.status = status;
    hit.evidence = evidence ? String(evidence).slice(0, 200) : null;
    hit.closedAt = (now instanceof Date ? now : new Date()).toISOString();
    savePromises(wsRoot, list, fsMod);
    return { ok: true, id, status };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

const dayPhrase = (ms) => {
  const days = Math.floor(ms / 86400_000);
  if (days <= 0) {
    const hours = Math.floor(ms / 3600_000);
    return hours <= 0 ? "刚刚" : `${hours} 小时前`;
  }
  return days === 1 ? "昨天" : `${days} 天前`;
};

/** 到期/积压判定：有明确 due 就比 due，否则按挂了多久算。 */
export function promiseAge(p, now = new Date()) {
  const at = new Date(p?.at).getTime();
  const nowMs = (now instanceof Date ? now : new Date()).getTime();
  if (!Number.isFinite(at)) return { ms: 0, overdue: false, phrase: "时间未知" };
  const ms = Math.max(0, nowMs - at);
  const dueMs = p?.due ? new Date(p.due).getTime() : NaN;
  const overdue = Number.isFinite(dueMs) ? nowMs > dueMs + 86400_000 : ms > 7 * 86400_000;
  return { ms, overdue, phrase: dayPhrase(ms) };
}

/** 待兑现清单（台前与提示词共用同一份排序：逾期在前，其次越久越前）。 */
export function pendingPromises(wsRoot, { now = new Date(), limit = 0, fsMod = fs } = {}) {
  const list = loadPromises(wsRoot, fsMod)
    .filter((p) => p.status === "pending")
    .map((p) => ({ ...p, age: promiseAge(p, now) }))
    .sort((a, b) => (Number(b.age.overdue) - Number(a.age.overdue)) || (b.age.ms - a.age.ms));
  return limit > 0 ? list.slice(0, limit) : list;
}

/**
 * 注入提示词的文本。**不写"已完成"**，只陈述账上有什么，并要求主动交代。
 * 没有待兑现承诺时返回空串——不要为了显得尽责而占上下文。
 */
export function pendingPromiseText(wsRoot, { now = new Date(), limit = 5, fsMod = fs } = {}) {
  const list = pendingPromises(wsRoot, { now, limit, fsMod });
  if (!list.length) return "";
  const lines = list.map((p) => `- ${p.age.phrase}：${p.text}${p.age.overdue ? "（已逾期）" : ""}`);
  return [
    "【待兑现承诺】以下是你自己此前说过要做的事，账上还没结清。",
    "主动交代进度：做完了就给出可核查的证据并说明；没做就说没做；不打算做了就明说并让对方决定是否销账。",
    "不要假装没说过，也不要把「打算做」讲成「已经做了」。",
    ...lines,
  ].join("\n");
}
