// engine/autonomy.mjs —— 授权状：元枢自己判断"这件事我能不能自己定"
// （2026-09-18，用户："得给她放权，让她有自己的判断标准，不能所有的进化策略都让我批，
//   好多我也看不懂啊，另外全让我回答，我不是给她打工了吗"）
//
// ── 这条批评的两半，都得答 ─────────────────────────────────────────────
//   ① "不能都让我批" → 技术判断该由系统自己做。用户看不懂权重表，让他批权重表，
//      等于把决策交给信息最少的一方——那不是谨慎，那是懒惰。
//   ② "好多我也看不懂" → 真正需要人拍板的，不是技术细节，而是**价值与后果**：
//      花钱、对外发布、动权限、碰用户数据、以及"口味"（喜欢哪种风格）。
//      所以提案必须先翻译成人话，并且允许"只回答行/不行"。
//
// ── 分级（判据是可机器核查的，不是感觉）────────────────────────────────
//   A 级 · 自决自动上线：四条同时满足
//        a. 可回放（改动是确定性函数，能拿历史 episode 对比）
//        b. 可证不更差（每一条历史都不更差，且至少一条更好；"赢家不可能更差"）
//        c. 可回滚（留撤销点，一条命令回到旧版本）
//        d. 不碰红线（权限/凭据/外部账号/花钱/删数据/发布推送/改用户数据）
//   B 级 · 自决自动上线但标注（缩水版 A）：a/c/d 满足，但**证据薄弱**
//        （样本 < MIN_EPISODES_A 或只有"打平"）→ 上线、显著标注"证据薄弱、可一键回退"。
//   C 级 · 必须人拍板：碰红线 / 不可回放（改行为语义、改人格、改这份授权状本身）/
//        影响外部世界 / 属于口味偏好 → 生成**人话版**提案进台前。
//
// ── 防"自己给自己扩权"（bootstrapping guard）──────────────────────────
//   改授权状本身永远是 C 级。元枢可以**提案**放宽自己的权限，但不能自己批准。
//   这条是整套东西的根：没有它，前面所有判据都是装饰。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "./atomic-io.mjs";

export const CHARTER_VERSION = 1;
export const MIN_EPISODES_A = 5;        // A 级要求的历史样本下限
export const AUTO_QUOTA_PER_DAY = 3;    // 自决配额：一天最多这么多次（防"自进化"变噪声）

export const DEFAULT_CHARTER = Object.freeze({
  version: CHARTER_VERSION,
  summary: "技术判断元枢自决（A/B 级），价值与后果的判断交人（C 级）",
  levels: {
    A: { label: "自决·自动上线", needReplayable: true, needNoWorse: true, needReversible: true, needRedlineClear: true, minEpisodes: MIN_EPISODES_A },
    B: { label: "自决·标注上线（证据薄弱）", needReplayable: true, needNoWorse: false, needReversible: true, needRedlineClear: true, minEpisodes: 1 },
    C: { label: "必须人拍板", description: "碰红线 / 不可回放 / 影响外部世界 / 口味偏好 / 改授权状" },
  },
  quotaPerDay: AUTO_QUOTA_PER_DAY,
});

/** 红线：这些一律 C 级，无论证据多漂亮。 */
const REDLINE = /权限|凭据|密钥|api\s?key|apikey|\bkey\b|token|密码|账号|付费|充值|花钱|采购|删除|清库|发布|上线|推送|\bpush\b|\bdeploy\b|外部|对外|发送|人格|授权状|自授权|扩权/i;
/** 口味/价值类：技术上看不出对错，得人定。 */
const TASTE = /风格|口味|审美|偏好|配色倾向|语气|人设|喜欢|不喜欢/;

export function charterPath(wsRoot) {
  return path.join(wsRoot, "记忆", "授权状.json");
}

/** 读授权状；没有就用默认值落一份（可被人改，改它就是 C 级）。 */
export function loadCharter(wsRoot, fsMod = fs) {
  try {
    const raw = fsMod.readFileSync(charterPath(wsRoot), "utf8");
    const j = JSON.parse(raw);
    if (j && j.levels?.A && j.levels?.C) return { ...DEFAULT_CHARTER, ...j, levels: { ...DEFAULT_CHARTER.levels, ...j.levels } };
  } catch { /* 不存在或坏了 → 默认 */ }
  return DEFAULT_CHARTER;
}

export function saveCharter(wsRoot, charter, fsMod = fs) {
  try {
    fsMod.mkdirSync(path.dirname(charterPath(wsRoot)), { recursive: true });
    atomicWriteText(charterPath(wsRoot), JSON.stringify(charter, null, 2));
    return { ok: true, path: charterPath(wsRoot) };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
}

/**
 * 给一条提案定级。**只看证据与后果，不看提案好不好听。**
 * evidence: { replayable, episodes, noWorse, betterCount, reversible, scope, text }
 *   scope: 'config'(元枢自己的配置/权重/阈值) | 'skill'(技能正文) | 'code' | 'external'
 */
export function classifyProposal(proposal, evidence = {}, charter = DEFAULT_CHARTER) {
  const text = `${proposal?.text || ""} ${evidence.text || ""} ${proposal?.kind || ""}`;
  const reasons = [];
  const c = charter.levels.C;

  // ① 红线优先：不碰红线是前提，不是加分项
  const hit = text.match(REDLINE);
  if (hit) { reasons.push(`碰红线（${hit[0]}）`); return { level: "C", reasons, label: c.label }; }
  // ② 改授权状自己 = 永远 C（防自扩权）
  if (/授权状|autonomy|charter/i.test(text)) { reasons.push("改授权状本身（防自扩权）"); return { level: "C", reasons, label: c.label }; }
  // ③ 不可回放 → 没有离线证据，改的是行为语义，得人看
  if (!evidence.replayable) { reasons.push("不可回放：拿不出历史对比的证据"); return { level: "C", reasons, label: c.label }; }
  // ④ 不可回滚 → 不做
  if (!evidence.reversible) { reasons.push("不可回滚"); return { level: "C", reasons, label: c.label }; }
  // ⑤ 影响外部世界 / 技能正文 / 口味 → 人
  if (evidence.scope === "external") { reasons.push("影响外部世界"); return { level: "C", reasons, label: c.label }; }
  if (TASTE.test(text)) { reasons.push("属于口味/价值判断（技术上看不出对错）"); return { level: "C", reasons, label: c.label }; }
  if (evidence.scope === "skill") { reasons.push("改技能正文=改行为语义"); return { level: "C", reasons, label: c.label }; }

  // ⑥ 到这里都是技术参数（权重/阈值/排序）→ A 或 B 看证据强度
  const episodes = Number(evidence.episodes) || 0;
  const a = charter.levels.A;
  if (evidence.noWorse && (evidence.betterCount || 0) > 0 && episodes >= (a.minEpisodes ?? MIN_EPISODES_A)) {
    reasons.push(`可回放 ${episodes} 条历史、每条都不更差、${evidence.betterCount} 条更好、可回滚、不碰红线`);
    return { level: "A", reasons, label: charter.levels.A.label };
  }
  reasons.push(`证据薄弱：${episodes} 条历史${evidence.noWorse ? "（打平）" : "（未证不更差）"}——先小步上线并标注`);
  return { level: "B", reasons, label: charter.levels.B.label };
}

export function ledgerPath(wsRoot) {
  return path.join(wsRoot, "记忆", "授权记录.jsonl");
}

export function loadLedger(wsRoot, fsMod = fs) {
  try {
    return fsMod.readFileSync(ledgerPath(wsRoot), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  } catch { return []; }
}

function appendLedger(wsRoot, row, fsMod = fs) {
  try {
    fsMod.mkdirSync(path.dirname(ledgerPath(wsRoot)), { recursive: true });
    fsMod.appendFileSync(ledgerPath(wsRoot), JSON.stringify(row) + "\n", "utf8");
    return true;
  } catch { return false }
}

/** 当天已自决几次（配额）。**被撤销掉的不再占配额**——退回去了就当没发生。 */
export function autoUsedToday(wsRoot, { now = new Date(), fsMod = fs } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = loadLedger(wsRoot, fsMod);
  const undone = new Set(rows.filter((r) => r.action === "revoked" && r.of).map((r) => r.of));
  return rows.filter((r) => r.auto && r.action === "auto" && String(r.at).slice(0, 10) === day && !undone.has(r.at)).length;
}

/**
 * 执行授权判定：
 *   · A/B 级 → 调 apply() 真正生效（自动上线），写账 + 记撤销点（可一键回退）
 *   · C 级 → 不动，产出**人话版**提案（供台前只答行/不行）
 * 返回里一定带 `human`：人话版说明（用户看不懂权重表，看到的就是这个）。
 */
export async function grant(proposal, evidence = {}, { wsRoot, charter, apply, now = new Date(), fsMod = fs, quotaPerDay, previous } = {}) {
  const ch = charter || loadCharter(wsRoot, fsMod);
  const verdict = classifyProposal(proposal, evidence, ch);
  const human = humanize(proposal, evidence, verdict);

  if (verdict.level === "C") {
    appendLedger(wsRoot, { at: new Date(now).toISOString(), action: "escalated", level: "C", text: proposal?.text || "", reasons: verdict.reasons, human }, fsMod);
    return { ok: true, level: "C", decided: false, verdict, human, message: `这条要你拍板：${human.ask}` };
  }

  const cap = quotaPerDay ?? ch.quotaPerDay ?? AUTO_QUOTA_PER_DAY;
  const used = autoUsedToday(wsRoot, { now, fsMod });
  if (used >= cap) {
    appendLedger(wsRoot, { at: new Date(now).toISOString(), action: "quota-blocked", level: verdict.level, text: proposal?.text || "", used, cap, human }, fsMod);
    return { ok: true, level: verdict.level, decided: false, verdict, human, message: `今天自决配额用完了（${used}/${cap}），这条顺延到明天或你说一声就放行` };
  }

  let applied = null;
  try { applied = typeof apply === "function" ? await apply() : null; } catch (e) {
    appendLedger(wsRoot, { at: new Date(now).toISOString(), action: "apply-failed", level: verdict.level, text: proposal?.text || "", error: String(e?.message || e).slice(0, 160) }, fsMod);
    return { ok: false, level: verdict.level, decided: false, verdict, human, message: `自决失败：${String(e?.message || e).slice(0, 120)}` };
  }
  const row = {
    at: new Date(now).toISOString(), action: "auto", level: verdict.level, auto: true,
    text: proposal?.text || "", reasons: verdict.reasons, evidence,
    undo: applied?.undo || null,           // 撤销点：一条命令/一个按钮回到旧版本
    previous: previous ?? null,
  };
  appendLedger(wsRoot, row, fsMod);
  return {
    ok: true, level: verdict.level, decided: true, verdict, human, applied, undo: row.undo,
    message: `我自己定了（${verdict.label}）：${human.what}${verdict.level === "B" ? "。证据薄弱，先小步上线，你一键就能退" : ""}`,
  };
}

/** 撤销一次自决（用户点一下就行，不需要懂技术）。 */
export async function revoke(wsRoot, { at = null, revert, now = new Date(), fsMod = fs } = {}) {
  const rows = loadLedger(wsRoot, fsMod);
  const target = at
    ? rows.find((r) => r.at === at && r.auto)
    : [...rows].reverse().find((r) => r.auto && r.action === "auto" && !rows.some((x) => x.action === "revoked" && x.of === r.at));
  if (!target) return { ok: false, reason: "没有可撤销的自决记录" };
  let reverted = null;
  try { reverted = typeof revert === "function" ? await revert(target) : null; } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 140) } }
  appendLedger(wsRoot, { at: new Date(now).toISOString(), action: "revoked", of: target.at, level: target.level, text: target.text, reverted }, fsMod);
  return { ok: true, revoked: target.at, text: target.text, reverted };
}

/** 人话版：用户看到的永远是这一段，而不是权重表。 */
export function humanize(proposal, evidence = {}, verdict = {}) {
  const what = String(proposal?.text || "").trim();
  const gain = evidence.betterCount
    ? `在 ${evidence.episodes} 条历史里有 ${evidence.betterCount} 条会更好，没有一条变差`
    : evidence.episodes ? `在 ${evidence.episodes} 条历史里没有变差、也没有变好` : "还没有历史证据";
  const risk = verdict.level === "A"
    ? "风险很小：只调我自己内部的技术参数，随时能退回旧版本"
    : verdict.level === "B"
      ? "证据还不够厚：我先小步上线并标注出来，你随时能一键退"
      : `这条我不敢自己定：${(verdict.reasons || []).join("；")}`;
  const ask = verdict.level === "C"
    ? `要不要我这么做：${what}？（你只回答「行」或「不行」就行；不懂技术细节没关系，我会照你的答复执行/放弃）`
    : "";
  return { what, gain, risk, ask, level: verdict.level, label: verdict.label };
}
