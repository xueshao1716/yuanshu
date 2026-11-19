// engine/usage-heat.mjs —— 技能 / 工具热度（2026-11-19）
//
// 记忆早就有热度（memory-forget 的 引用×新近×重要），技能和工具没有：
// 每轮下发哪些工具是写死的名单在裁（brain-regions.filterToolsByTier），技能目录按字母排，
// 天天用的工具照样被收起、每次都得先 request_tool 取回。
// 这里给技能和工具记账、算热度，让常用的越用越顺：
//   · 热档工具直接进工具表（额外最多 HOT_TOOL_CAP 个），不用再取回；
//   · 热档技能在技能目录里排前面，匹配时加分（只在本来就有关键词命中时加，避免什么都配上它）；
//   · 用户可在「能力」页钉住 / 收起某项，或整体关掉热度（回到写死名单）。
// 账本：<工作区>/记忆/运行时/技能工具热度.json。按天计数，只留 60 天。
// 首次启动从 做梦/episodes.jsonl（技能）和运行事件流（工具，14 天）回填。

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./atomic-io.mjs";

export const HOT_TOOL_CAP = 8;
const KEEP_DAYS = 60;
const WINDOW_DAYS = 30;
const HALF_LIFE_DAYS = 14;
const DAY = 86400_000;
const FLUSH_MS = 5000;

let wsRoot = "";
let doc = null;
let flushTimer = null;

const emptyDoc = () => ({ version: 1, enabled: true, items: {}, prefs: { pinned: [], hidden: [] }, backfilledAt: null });
const keyOf = (kind, name) => `${kind}:${name}`;
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

export function heatFile(root = wsRoot) { return path.join(root, "记忆", "运行时", "技能工具热度.json"); }

export function initUsageHeat({ wsRoot: root } = {}) {
  wsRoot = String(root || "");
  doc = null;
  return load();
}

function load() {
  if (doc) return doc;
  doc = emptyDoc();
  if (!wsRoot) return doc;
  try {
    const raw = JSON.parse(fs.readFileSync(heatFile(), "utf8"));
    doc = { ...emptyDoc(), ...raw, prefs: { ...emptyDoc().prefs, ...(raw.prefs || {}) }, items: raw.items || {} };
  } catch {}
  return doc;
}

function scheduleFlush() {
  if (!wsRoot || flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushUsageHeat(); }, FLUSH_MS);
  flushTimer.unref?.();
}

export function flushUsageHeat() {
  if (!wsRoot || !doc) return;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  try { atomicWriteJson(heatFile(), doc); } catch {}
}

function prune(item, now) {
  const cutoff = dayOf(now - KEEP_DAYS * DAY);
  for (const d of Object.keys(item.days || {})) if (d < cutoff) delete item.days[d];
}

/** 记一次使用。kind: "tool" | "skill"。 */
export function recordUse(kind, name, { ok = true, ms = null, at = Date.now() } = {}) {
  const n = String(name || "").trim();
  if (!n || (kind !== "tool" && kind !== "skill")) return;
  const d = load();
  const k = keyOf(kind, n);
  const item = d.items[k] || (d.items[k] = { kind, name: n, count: 0, fail: 0, totalMs: 0, timed: 0, lastAt: null, days: {} });
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return;
  item.count += 1;
  if (!ok) item.fail += 1;
  if (Number.isFinite(ms) && ms >= 0) { item.totalMs += ms; item.timed += 1; }
  const day = dayOf(t);
  item.days[day] = (item.days[day] || 0) + 1;
  if (!item.lastAt || t > Date.parse(item.lastAt)) item.lastAt = new Date(t).toISOString();
  prune(item, Date.now());
  scheduleFlush();
}

/** 热度分 0~1：近 30 天次数（饱和）× 0.6 + 新近度（半衰期 14 天）× 0.3 + 成功率 × 0.1。从没用过 = 0。
 *  权重让「今天只用过一次」落在温档（约 0.47），近期用到 3 次以上才进热档。 */
export function heatScore(item, now = Date.now()) {
  if (!item?.count || !item.lastAt) return 0;
  const cutoff = dayOf(now - WINDOW_DAYS * DAY);
  let recent = 0;
  for (const [d, c] of Object.entries(item.days || {})) if (d >= cutoff) recent += c;
  const freq = 1 - Math.exp(-recent / 8);
  const age = Math.max(0, (now - Date.parse(item.lastAt)) / DAY);
  const recency = Math.pow(0.5, age / HALF_LIFE_DAYS);
  const success = item.count ? 1 - item.fail / item.count : 1;
  return Number((0.6 * freq + 0.3 * recency + 0.1 * success).toFixed(3));
}

/** 档位：hot 热 / warm 温 / cold 冷 / idle 没用过。钉住的一律 hot。 */
export function heatTier(score, { pinned = false, used = score > 0 } = {}) {
  if (pinned) return "hot";
  if (!used) return "idle";
  if (score >= 0.55) return "hot";
  if (score >= 0.25) return "warm";
  return "cold";
}

function stat(kind, name, now) {
  const d = load();
  const k = keyOf(kind, name);
  const item = d.items[k];
  const pinned = d.prefs.pinned.includes(k);
  const hidden = d.prefs.hidden.includes(k);
  const score = heatScore(item, now);
  const cutoff = dayOf(now - WINDOW_DAYS * DAY);
  let count30 = 0;
  for (const [day, c] of Object.entries(item?.days || {})) if (day >= cutoff) count30 += c;
  // 近 14 天逐日次数，页面画小走势
  const trend = Array.from({ length: 14 }, (_, i) => item?.days?.[dayOf(now - (13 - i) * DAY)] || 0);
  return {
    kind, name, score, count30, trend, pinned, hidden,
    tier: heatTier(score, { pinned, used: !!item?.count }),
    count: item?.count || 0, fail: item?.fail || 0,
    avgMs: item?.timed ? Math.round(item.totalMs / item.timed) : null,
    lastAt: item?.lastAt || null,
  };
}

export function heatEnabled() { return load().enabled !== false; }

/** 给接口用：全部记过账的条目 + 偏好。前端再跟技能 / 工具清单合并，没记过账的就是 idle。 */
export function heatSnapshot(now = Date.now()) {
  const d = load();
  const keys = new Set([...Object.keys(d.items), ...d.prefs.pinned, ...d.prefs.hidden]);
  const items = [];
  for (const k of keys) {
    const i = k.indexOf(":");
    items.push(stat(k.slice(0, i), k.slice(i + 1), now));
  }
  return { enabled: heatEnabled(), hotToolCap: HOT_TOOL_CAP, backfilledAt: d.backfilledAt, items };
}

/** 偏好：action = pin | hide | reset；或 { enabled } 整体开关。 */
export function setHeatPref({ kind, name, action, enabled } = {}) {
  const d = load();
  if (typeof enabled === "boolean") d.enabled = enabled;
  if (kind && name && action) {
    const k = keyOf(kind, String(name));
    d.prefs.pinned = d.prefs.pinned.filter((x) => x !== k);
    d.prefs.hidden = d.prefs.hidden.filter((x) => x !== k);
    if (action === "pin") d.prefs.pinned.push(k);
    else if (action === "hide") d.prefs.hidden.push(k);
  }
  flushUsageHeat();
  return heatSnapshot();
}

const toolName = (t) => t?.function?.name || t?.name || "";

/**
 * 按热度调整工具表：
 *   · 被收起的热档 / 钉住的工具放回来（按分数取前 HOT_TOOL_CAP 个）；
 *   · 用户收起的工具从表里拿掉（protect 里的协议必需工具除外），之后走 request_tool 目录。
 * 热度关掉时原样返回。
 */
export function applyToolHeat(all, kept, { protect = new Set(), now = Date.now() } = {}) {
  if (!Array.isArray(all) || !Array.isArray(kept) || !heatEnabled()) return kept;
  const d = load();
  const hidden = new Set(d.prefs.hidden.filter((k) => k.startsWith("tool:")).map((k) => k.slice(5)));
  const out = kept.filter((t) => !hidden.has(toolName(t)) || protect.has(toolName(t)));
  const have = new Set(out.map(toolName));
  const back = all
    .filter((t) => { const n = toolName(t); return n && !have.has(n) && !hidden.has(n); })
    .map((t) => ({ t, s: stat("tool", toolName(t), now) }))
    .filter(({ s }) => s.tier === "hot")
    .sort((a, b) => (b.s.pinned - a.s.pinned) || (b.s.score - a.s.score))
    .slice(0, HOT_TOOL_CAP)
    .map(({ t }) => t);
  // 保持原表顺序，模型看到的工具表结构稳定
  const backSet = new Set(back.map(toolName));
  return all.filter((t) => have.has(toolName(t)) || backSet.has(toolName(t)));
}

const TIER_ORDER = { hot: 0, warm: 1, cold: 2, idle: 3 };
const TIER_BOOST = { hot: 3, warm: 1, cold: 0, idle: 0 };

/**
 * 按热度给技能目录排序并附上匹配加分（boost）；收起的技能标 hidden，匹配时跳过。
 * 只按档位排（档内保持原顺序）：分数天天在动，按分数排会让系统提示每轮都变、缓存失效。
 */
export function rankSkills(list, now = Date.now()) {
  if (!Array.isArray(list) || !heatEnabled()) return list;
  return list
    .map((s, i) => { const st = stat("skill", s.name, now); return { s: { ...s, boost: TIER_BOOST[st.tier], hidden: st.hidden || undefined }, o: TIER_ORDER[st.tier], i }; })
    .sort((a, b) => (a.o - b.o) || (a.i - b.i))
    .map(({ s }) => s);
}

/** 首次启动回填：技能从 episodes.jsonl，工具从运行事件流（只回填一次）。 */
export async function backfillUsageHeat({ episodesFile, eventsDir } = {}) {
  const d = load();
  if (d.backfilledAt) return { skipped: true };
  let skills = 0, tools = 0;
  try {
    const raw = await fs.promises.readFile(episodesFile, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.includes("skill-match")) continue;
      try { const e = JSON.parse(line); if (e.kind === "skill-match" && e.choice) { recordUse("skill", e.choice, { at: e.at }); skills++; } } catch {}
    }
  } catch {}
  try {
    const files = await fs.promises.readdir(eventsDir);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      let raw = "";
      try { raw = await fs.promises.readFile(path.join(eventsDir, f), "utf8"); } catch { continue; }
      for (const line of raw.split("\n")) {
        if (!line.includes('"tool_end"')) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === "tool_end" && e.data?.name) { recordUse("tool", e.data.name, { ok: e.data.isError !== true, ms: e.data.durationMs, at: e.ts }); tools++; }
        } catch {}
      }
      await new Promise((r) => setImmediate(r)); // 让出事件循环，别卡住启动
    }
  } catch {}
  d.backfilledAt = new Date().toISOString();
  flushUsageHeat();
  return { skills, tools };
}

export function _resetUsageHeat() { if (flushTimer) clearTimeout(flushTimer); flushTimer = null; wsRoot = ""; doc = null; }
