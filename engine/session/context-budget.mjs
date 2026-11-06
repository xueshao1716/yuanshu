// ===== session/context-budget.mjs —— 上下文预算相关的纯函数（2026-11-06 从 manager.mjs 抽出）=====
//
// 这 4 个函数不碰任何模块级状态（不依赖 _cwd/_SessionManager/lifecycle），
// 只读会话文件并算 token 预算，所以能安全搬出来。
import fs from "node:fs";
import path from "node:path";
import { findSession } from "./files.mjs";
import { headroomCheck, estimateTokensFromText } from "../context-headroom.mjs";

export function estimateCompactedTokens(file) {
  try {
    if (!file || !fs.existsSync(file)) return 0;
    const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    let cut = -1;
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "compaction") { cut = i; break; }
    const from = cut >= 0 ? entries.slice(cut) : entries;
    let n = 0;
    for (const e of from) {
      if (e.type === "compaction") { n += estimateTokensFromText(String(e.summary || "")); continue; }
      if (e.type !== "message") continue;
      const m = e.message || {};
      const c = m.content;
      if (typeof c === "string") n += estimateTokensFromText(c);
      else if (Array.isArray(c)) for (const b of c) n += estimateTokensFromText(typeof b === "string" ? b : (b?.text || b?.thinking || ""));
    }
    return Math.round(n);
  } catch { return 0; }
}

// ══ 上下文余量闸门（2026-09-18）══════════════════════════════════════
// 真机事故：会话涨到 195k/200k 时，兼容适配器给模型的输出预算只剩 ~400 token，
// 答案在 387 token 被 length 截断，SDK 又把半截答案删掉重试（重试只吐 1 token）——
// 用户看到"说到一半被打断"。
// 这里在**开跑前**把会话压到有输出余量为止，然后重开会话让 SDK 读到压缩后的历史
// （压缩是改文件，内存里的 SessionManager 树不会自己刷新，必须重新 open）。
// 返回 { entry, before, after, compacted, reason }：entry 可能换成新的那个。

export async function ensureContextHeadroom(id, entry, model, { minOutput = 8192 } = {}) {
  const out = { entry, before: null, after: null, compacted: false, reason: "" };
  try {
    const found = findSession(id);
    const file = entry?.sm?.getSessionFile?.() || found?.file;
    if (!file || !fs.existsSync(file)) return out;
    const ctx = Number(model?.contextWindow) || 0;
    if (ctx <= 0) return out;                             // 不知道窗口就别乱压
    const used = lastTurnContextTokens(entry, file);
    out.before = { contextWindow: ctx, usedTokens: used };
    const before = headroomCheck({ contextWindow: ctx, usedTokens: used, declaredMaxTokens: model?.maxTokens, minOutput });
    if (!before.tight) return out;
    console.log(`[headroom] ${id}: 上下文 ${used}/${ctx}（占 ${Math.round(before.ratio * 100)}%），输出余量仅 ${before.room} token → 先压缩`);
    const r = await compactSession(file, model, true);
    out.compacted = !r?.skip;
    if (r?.skip) out.reason = r.reason || "compact-skip";
    // 压缩后重开会话：否则内存里的历史还是旧的，SDK 照样按满上下文发请求
    try { entry?.agent?.dispose?.(); } catch {}
    _activeSessions.delete(id);
    const reopened = await openSession(id);
    if (reopened) out.entry = reopened;
    const est = out.compacted ? estimateCompactedTokens(file) : 0;
    const used2 = out.compacted && est > 0 ? est : lastTurnContextTokens(out.entry, file);
    out.after = { contextWindow: ctx, usedTokens: used2 };
    out.freed = Math.max(0, (out.before?.usedTokens || 0) - used2);
    const after = headroomCheck({ contextWindow: ctx, usedTokens: used2, declaredMaxTokens: model?.maxTokens, minOutput });
    out.roomAfter = after.room;
    if (!out.compacted && !r?.skip) out.reason = "compact-null";
    console.log(`[headroom] ${id}: 压缩${out.compacted ? "完成" : "跳过(" + out.reason + ")"} → 上下文 ${used2}/${ctx}，输出余量 ${after.room} token`);
  } catch (e) {
    out.reason = String(e?.message || e).slice(0, 120);
    console.log(`[headroom] 余量闸门异常（不阻断本轮）: ${out.reason}`);
  }
  return out;
}

// 会话最后一条 assistant 记录的上下文规模（provider 的 totalTokens，含 cacheRead）
// 内存树优先（刚跑完的那轮就在里面），读不到再退回文件尾部。

export function isFirstTurn(sm) {
  try {
    const roots = sm.getTree() || [];
    const hasMsg = roots.some(n => n.entry?.type === "message" && ["user", "assistant"].includes(n.entry?.message?.role));
    return !hasMsg;
  } catch { return false; }
}


export function _clearSessionModelKey(sid) {
  try {
    const p = path.join(_getAgentDir(), "session-model-keys.json");
    const d = _readJsonFile(p) || {};
    if (d[sid]) { delete d[sid]; _writeJsonFile(p, d); }
  } catch {}
}

