// engine/dream.mjs —— 做梦：拿历史当模拟器，离线评估"要不要改"
// （2026-09-18，用户："openclaw、hermes 都有做梦，我觉得这是个重要方向"）
//
// 借鉴 Dream-RSI 的历史回放思路；这里只评估确定性技能匹配策略，
// 不模拟新的模型回答，也不训练模型权重。
// activate_skill 只证明选过这个技能；参与评分还需独立或人工核验的技能标签。
// 候选与现役逐条比较，历史指标不退步且有收益才生成候选建议。
// evolution-cycle 另做发现/保留集隔离、后续真实任务观察和治理检查，
// 然后进入有期限试运行与可回滚监测。历史通过不保证未来改善。

import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "./atomic-io.mjs";
import { verifiedSkillEpisode } from './trace-evidence.mjs';

const DIR = () => ["记忆", "做梦"];
export const EPISODES_FILE = "episodes.jsonl";
export const MAX_EPISODES = 2000;

export function dreamPaths(wsRoot) {
  const dir = path.join(wsRoot, ...DIR());
  return { dir, episodes: path.join(dir, EPISODES_FILE), log: path.join(dir, "做梦日志.md"), active: path.join(dir, "现役策略.json") };
}

// ── 现役策略的存档：做梦赢了要能"真的生效"，也要能"一键退回" ──────────────
// 存在工作区（不是代码里）：自决上线改的是这份存档，代码里的 MATCH_WEIGHTS 永远是出厂默认，
// 所以"退回"就是删掉/改回这份存档，绝不会把源码改脏。
export function currentWeights(wsRoot, fsMod = fs) {
  try {
    const j = JSON.parse(fsMod.readFileSync(dreamPaths(wsRoot).active, "utf8"));
    if (j && typeof j.weights === "object") return { id: String(j.id || ""), weights: j.weights, at: j.at || null };
  } catch { /* 没有存档 = 用出厂默认 */ }
  return { id: "", weights: null, at: null };
}

export function promoteWeights(wsRoot, id, weights, { now = new Date(), fsMod = fs } = {}) {
  try {
    fsMod.mkdirSync(path.dirname(dreamPaths(wsRoot).active), { recursive: true });
    atomicWriteText(dreamPaths(wsRoot).active, JSON.stringify({ id, weights, at: new Date(now).toISOString() }, null, 2));
    return { ok: true, id };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
}

export function resetWeights(wsRoot, { fsMod = fs } = {}) {
  try { fsMod.unlinkSync(dreamPaths(wsRoot).active); return { ok: true, id: "", weights: null }; }
  catch { return { ok: true, id: "", weights: null } }
}

function ensureDir(wsRoot) {
  const { dir } = dreamPaths(wsRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** episode 保存输入、当时的选择和可选核验信息；选择本身不是正确标签。 */
export function appendEpisodes(wsRoot, episodes, fsMod = fs) {
  const list = (Array.isArray(episodes) ? episodes : []).filter((e) => e && e.kind && e.input);
  if (!list.length) return { ok: true, added: 0 };
  try {
    ensureDir(wsRoot);
    const withAt = list.map((e) => ({ at: e.at || new Date().toISOString(), ...e }));
    fsMod.appendFileSync(dreamPaths(wsRoot).episodes, withAt.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    compactEpisodes(wsRoot, fsMod);
    return { ok: true, added: withAt.length };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
}

export function loadEpisodes(wsRoot, { kind = "", limit = 0, fsMod = fs } = {}) {
  const file = dreamPaths(wsRoot).episodes;
  let raw = "";
  try { raw = fsMod.readFileSync(file, "utf8"); } catch { return []; }
  // 仅合并同一运行/会话、同一输入且核验信息一致的记录。
  // 不把跨会话的同名任务或未核验选择并入已核验标签。
  const byKey = new Map();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e = null;
    try { e = JSON.parse(t); } catch { continue }
    if (!e?.kind || !e.input) continue;
    if (kind && e.kind !== kind) continue;
    const key = JSON.stringify([e.kind, e.input, e.runId || '', e.sessionId || e.source || '', e.verification || null]);
    const cur = byKey.get(key) || { ...e, choices: [] };
    const add = [...(Array.isArray(e.choices) ? e.choices : []), e.choice].filter(Boolean);
    cur.choices = [...new Set([...(cur.choices || []), ...add])];
    cur.choice = cur.choices[0];
    cur.at = e.at || cur.at;
    byKey.set(key, cur);
  }
  const out = [...byKey.values()];
  return limit > 0 ? out.slice(-limit) : out;
}

/** 文件超限时只留最近的（做梦要的是"最近的历史"，不是全量考古）。 */
function compactEpisodes(wsRoot, fsMod = fs) {
  try {
    const all = loadEpisodes(wsRoot, { fsMod });
    if (all.length <= MAX_EPISODES) return;
    atomicWriteText(dreamPaths(wsRoot).episodes, all.slice(-MAX_EPISODES).map((e) => JSON.stringify(e)).join("\n") + "\n");
  } catch { /* 压缩失败不影响主流程 */ }
}

/**
 * 回放：把一套策略在历史 episode 上跑一遍。
 * `rank(episode, policy)` 由调用方给（元枢里就是"这套权重会把哪个技能排在第一位"）。
 *
 * 标签可以是一组技能：同一个任务可能需要多个技能。
 * （真机上就出现了 "现在可以好好画了吗" → image-generation + gpt-image-2）。
 * 按单一真值打分，正确答案会被算成错——所以 `ep.choices` 优先，`ep.choice` 兜底。
 * 得分口径：排第一且命中真值 1 分，进前三命中 0.5 分，否则 0 分。
 */
export function replayPolicy(policy, episodes, { rank } = {}) {
  const eps = Array.isArray(episodes) ? episodes : [];
  const rows = eps.map((ep) => {
    const truth = (Array.isArray(ep.choices) && ep.choices.length ? ep.choices : [ep.choice]).filter(Boolean);
    const ranked = rank(ep, policy);
    const list = (Array.isArray(ranked) ? ranked : []).slice(0, 3);
    const top1Hit = list[0] && truth.includes(list[0]);
    const anyHit = list.some((n) => truth.includes(n));
    const score = top1Hit ? 1 : anyHit ? 0.5 : 0;
    return { input: String(ep.input).slice(0, 120), truth, ranked: list, score, at: ep.at };
  });
  const total = rows.reduce((s, r) => s + r.score, 0);
  return { policyId: policy.id, episodes: rows.length, total, accuracy: rows.length ? Number((total / rows.length).toFixed(4)) : 0, rows };
}

/**
 * 做梦主流程：候选里**必须**含当前在用的策略（规矩①），赢家要"一条都不更差"（规矩②）。
 * 返回提案，不改任何东西。
 */
export function dream({ kind, episodes, incumbentId, candidates, rank }) {
  const observed = Array.isArray(episodes) ? episodes : [];
  const eps = kind === 'skill-match' ? observed.filter(verifiedSkillEpisode) : observed;
  if (!eps.length) return { ok: false, reason: observed.length ? "缺少已核验的技能标签；历史激活仅是观察记录" : "没有历史 episode 可回放", kind,
    episodes: observed.length, eligibleEpisodes: 0, winner: null, table: [], proposal: null };
  // 必须包含现役作为比较基准；历史比较结论不能外推到未来。
  if (!incumbentId) return { ok: false, reason: "必须给出现役策略 id，才能比较历史指标", kind };
  const all = [incumbentId, ...(candidates || []).map((c) => c.id).filter((id) => id && id !== incumbentId)];

  const policies = new Map((candidates || []).map((c) => [c.id, c]));
  const evaluated = all.map((id) => {
    const policy = policies.get(id) || { id, weights: null };
    const r = replayPolicy({ id, ...policy }, eps, { rank });
    return { id, ...r };
  });
  const incumbent = evaluated.find((e) => e.id === incumbentId);

  const verdicts = evaluated.map((e) => {
    if (e.id === incumbentId) return { id: e.id, role: "incumbent", accuracy: e.accuracy, decision: "keep" };
    const worse = e.rows.filter((r, i) => r.score < incumbent.rows[i].score).length;
    const better = e.rows.filter((r, i) => r.score > incumbent.rows[i].score).length;
    const noWorse = worse === 0;
    return {
      id: e.id, role: "challenger", accuracy: e.accuracy,
      better, worse,
      decision: noWorse && better > 0 ? "promote" : noWorse ? "tie" : "reject",
      reason: noWorse
        ? (better > 0 ? `每条都不更差，其中 ${better} 条更好` : "与现役打平（不值得改）")
        : `有 ${worse} 条比现役更差——平均分再高也不换`,
    };
  });

  const winner = verdicts.find((v) => v.decision === "promote") || null;
  return {
    ok: true, kind, episodes: eps.length, eligibleEpisodes: eps.length,
    table: verdicts,
    winner: winner?.id || null,
    proposal: winner
      ? { kind: "ask", text: `把「${kind}」策略从 ${incumbentId} 换成 ${winner.id}（回放 ${eps.length} 条历史，每条都不更差、${winner.better} 条更好）`, due: null }
      : null,
    note: "仅表示已核验历史样本上的指标不退步；不能保证后续真实任务不退步。",
  };
}

/** 做梦记录（人可读，和运行日志同源）。 */
export function writeDreamLog(wsRoot, kind, result, { now = new Date(), fsMod = fs } = {}) {
  try {
    ensureDir(wsRoot);
    const lines = [
      `### ${new Date(now).toISOString()} 做梦：${kind}`,
      `回放历史 ${result.episodes} 条；现役 ${result.table.find((t) => t.role === "incumbent")?.id}`,
      ...result.table.map((t) => `- [${t.decision}] ${t.id}：准确率 ${t.accuracy}${t.reason ? `（${t.reason}）` : ""}`),
      result.winner ? `→ 提案：${result.proposal.text}` : "→ 没有可提案的赢家（保持不变）",
      "",
    ];
    fsMod.appendFileSync(dreamPaths(wsRoot).log, lines.join("\n") + "\n", "utf8");
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
}

/**
 * **在线**记一条技能选择（2026-09-18 第二轮）。
 *
 * 为什么要在线记：头一版只能"回填"——扫会话文件把历史里的 activate_skill 挖出来。
 * 结果是**数据饿死**：做梦、授权状、回放全都建好了，却因为只有 1~2 条 episode 而永远得不出结论。
 * 机制不缺，缺的是"每次真发生过的事都被记下来"。这里就是那个记录点：
 * 谁在什么任务句上激活了哪个技能，发生时立刻落一条。
 */
export function recordSkillChoice(wsRoot, { input, skill, source = "live", sessionId = '', runId = '', at = new Date(), fsMod = fs } = {}) {
  const msg = String(input || "").trim();
  const name = String(skill || "").trim();
  if (!msg || !name) return { ok: false, reason: "缺 input 或 skill" };
  return appendEpisodes(wsRoot, [{ kind: "skill-match", at: new Date(at).toISOString(), input: msg.slice(0, 500), choice: name, choices: [name], source, sessionId, runId }], fsMod);
}

/** 从会话里提取技能选择观察；同一会话同一用户轮内合并，仍需另行核验。 */
export function skillEpisodesFromSessions(sessionFiles, { readFile = (f) => fs.readFileSync(f, "utf8"), limit = 500, strict = false } = {}) {
  const byInput = new Map();
  for (const file of sessionFiles || []) {
    let raw = "";
    try { raw = readFile(file); } catch (error) { if (strict) throw error; continue }
    let lastUser = "";
    let turn = 0;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let e = null;
      try { e = JSON.parse(t); } catch (error) { if (strict) throw new Error(`Invalid session JSON: ${error.message}`); continue }
      const m = e?.message;
      if (!m) continue;
      if (m.role === "user") {
        const text = (Array.isArray(m.content) ? m.content : []).map((c) => c?.text || "").join(" ").trim();
        if (text && !text.startsWith("【元枢内置技能库】")) { lastUser = text.slice(0, 500); turn++; }
        continue;
      }
      if (m.role === "toolResult" && m.toolName === "activate_skill") {
        const text = (Array.isArray(m.content) ? m.content : []).map((c) => c?.text || "").join(" ");
        const hit = text.match(/技能\s+([\w.-]+)\s+已加载/);
        if (!hit || !lastUser) continue;
        const key = `${file}:${turn}`;
        const cur = byInput.get(key) || { kind: "skill-match", runId: key, at: e.timestamp || null, input: lastUser, choices: [], sources: [] };
        if (!cur.choices.includes(hit[1])) cur.choices.push(hit[1]);
        const src = path.basename(String(file));
        if (!cur.sources.includes(src)) cur.sources.push(src);
        byInput.set(key, cur);
      }
    }
  }
  const out = [...byInput.values()].map((e) => ({ ...e, choice: e.choices[0], source: e.sources[0] }));
  return out.slice(-limit);
}
