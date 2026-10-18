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
    atomicWriteText(promisePaths(wsRoot).file, JSON.stringify(next, null, 2), fsMod);
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
    const saved = savePromises(wsRoot, [...existing, ...added], fsMod);
    return saved.ok ? { ok: true, added: added.length } : { ok: false, added: 0, error: saved.error };
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
    const saved = savePromises(wsRoot, list, fsMod);
    if (!saved.ok) return { ok: false, id, status, reason: `承诺账本写入失败：${saved.error || "未知错误"}` };
    return { ok: true, id, status };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

// ── 2026-10-18：销账工具 + 超期自动搁置 ──────────────────────────────
//
// 真机投诉：「我明确表示不需要了，她一直挂在记忆里当代办。」
// 根因：closePromise 只有夜间复盘和网页按钮在调，**模型自己没有销账手段**，
// 于是用户说"不用了"之后这条账只能一直 pending；14 天以上的越积越多（实测 48 条）。
//
// 因此补两件事：
//   ① 给模型一个 promise_close（**只允许 dropped**）。规则①仍然成立：绝不自动/自行标记已兑现。
//   ② 超期搁置：pending 超过 14 天自动转 expired（不是 done），可人工改回，且不再进提示词。
export const PROMISE_STALE_DAYS = 14;

export const PROMISE_TOOL_SCHEMAS = [{
  type: "function",
  function: {
    name: "promise_close",
    description: "把一条自己承诺过、但用户已明确表示不需要的事从待兑现账上销掉（只能销账，不能标记已兑现）。用户说「不用了 / 不需要 / 别做了 / 算了」时立刻调用，不要留着继续当待办。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "【待兑现承诺】清单里那一条的 id（p_ 开头）" },
        reason: { type: "string", description: "用户的明确说法，例如「这个不用了」。会作为销账证据留存" },
      },
      required: ["id", "reason"],
    },
  },
}];

/** 超期未结清的 pending 自动转 expired。不是"已兑现"，是"不再当待办"。 */
export function expireStalePromises(wsRoot, { days = PROMISE_STALE_DAYS, now = new Date(), fsMod = fs } = {}) {
  try {
    const list = loadPromises(wsRoot, fsMod);
    const nowMs = (now instanceof Date ? now : new Date()).getTime();
    let expired = 0;
    for (const p of list) {
      if (p.status !== "pending") continue;
      const at = new Date(p.at).getTime();
      if (!Number.isFinite(at)) continue;
      if (nowMs - at <= days * 86400_000) continue;
      p.status = "expired";
      p.evidence = `超过 ${days} 天未结清，自动搁置（未标记已兑现，可人工改回）`;
      p.closedAt = new Date(nowMs).toISOString();
      expired++;
    }
    if (!expired) return { ok: true, expired: 0 };
    const saved = savePromises(wsRoot, list, fsMod);
    return saved.ok ? { ok: true, expired } : { ok: false, expired: 0, error: saved.error };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

/** 模型侧销账执行器：只允许 dropped，且必须带用户原话作为证据。 */
export function promiseExtraExecutors(wsRoot, { now = () => new Date() } = {}) {
  return {
    promise_close: (args = {}) => {
      const id = String(args?.id || "").trim();
      const reason = String(args?.reason || "").trim();
      if (!id) return { text: "缺少 id：用【待兑现承诺】清单里的 p_ 开头编号，不要编造", isError: true };
      if (!reason) return { text: "缺少 reason：写清用户是怎么说的（例如「这个不用了」）作为销账证据", isError: true };
      const hit = loadPromises(wsRoot).find((p) => p.id === id);
      if (!hit) return { text: `账上没有 ${id}；用清单里的真实 id，不要猜`, isError: true };
      if (hit.status !== "pending") return { text: `这条已经结清（${hit.status}），不用重复销账`, isError: false };
      const r = closePromise(wsRoot, id, { status: "dropped", evidence: `用户明确不需要：${reason}`, now: now() });
      if (!r.ok) return { text: `销账失败：${r.reason || r.error || "未知错误"}`, isError: true };
      const left = pendingPromises(wsRoot, { now: now() }).length;
      const brief = hit.text.length > 60 ? `${hit.text.slice(0, 60)}…` : hit.text;
      return { text: `已销账：${brief}。账上还剩 ${left} 条待兑现。`, isError: false };
    },
  };
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
  // 带 id：不给编号，模型没法调用 promise_close 销账（2026-10-18）
  const lines = list.map((p) => `- [${p.id}] ${p.age.phrase}：${p.text}${p.age.overdue ? "（已逾期）" : ""}`);
  return [
    "【待兑现承诺】以下是你自己此前说过要做的事，账上还没结清。",
    "主动交代进度：做完了就给出可核查的证据并说明；没做就说没做。",
    "用户明确说过「不用了 / 不需要 / 别做了 / 算了」的，**立刻用 promise_close(id, reason=他的原话) 销账**，不要留着继续当待办，也不要再提。",
    "不要假装没说过，也不要把「打算做」讲成「已经做了」。",
    ...lines,
  ].join("\n");
}
