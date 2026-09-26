// 元枢小语情绪引擎（VAD 三维模型，曦系移植版）
// 核心：情绪不是输出装饰，而是驱动行为的信号（反向情绪激发）
// valence 愉悦度 / arousal 唤醒度 / dominance 支配度
// 2026-08-19 拆模块：人格基因 → engine/gene.mjs，技能基因 → engine/skill-gene.mjs
// 2026-09-04 曦系深度移植（伙伴点名"要 xi-system 那个的丰富度"）：
//   ① 人格温暖基线：decay 回归目标是"温和的暖"而非冷中性（xi: personality_valence 0.55）
//   ② 连续向量词表：关键词命中叠加三维增量（clamp ±0.15），替换二元正则命中
//   ③ 时间节律：早晨微暖微醒、深夜降唤醒（xi: time_arousal/time_valence）
//   ④ 主+次情绪：欧氏最近点标注 primary，上一个 primary 退为 secondary（xi: update_label）
//   ⑤ residue 反作用：温暖减缓负面衰减/伤害减缓正面衰减；最近触动事件入指令
//   ⑥ 输出侧感知：自己回复的长度/短促度也微调 arousal（xi: update_from_output）
// 保留：residue→记忆联动钩子、基因联动、情绪潮汐落盘（08-19/09-03/09-04 前版）

import fs from "node:fs";
import path from "node:path";
import { safeEmotion, observationTime } from './emotion-display.mjs';
import { initGene, geneBias, updateGenes, geneDirective, geneSnapshot } from "./gene.mjs";
import { initSkillGene, bindSkillIndex, detectSkillDomain, updateSkillGene, getSkillGenes, skillDirective } from "./skill-gene.mjs";
import { extractEntities } from "./yuanshu-memroute.mjs";

// ── 人格基线（曦系）：小语闲下来时情绪落点是"温和的暖"，不是冷中性 ──
const PERSONALITY = { valence: 0.55, arousal: 0.35, dominance: 0.5 };
const DEFAULT_STATE = {
  valence: 0.5, arousal: 0.3, dominance: 0.5, intensity: 0.1,
  primary: "calm", secondary: "loving",
  lastTalk: null, lastResidueAt: null, lastTideAt: null, lastStrongAt: null, lastFeelingApplyTs: null,
  residue: { warmth: 0, hurt: 0, curiosity: 0, last_event: "", last_event_time: "", edges: {} },
};
const states = new Map(); // sessionId -> state
let displayObservation = null;

let wsRoot = null;
let _memoryNudgeHook = null; // 情绪→记忆联动钩子：residue 跨阈值时由 server 注入
export function setMemoryNudgeHook(fn) { _memoryNudgeHook = fn; }

// 初始化：server 启动时调用，传入工作空间根
export function init(root) {
  if (root && root !== wsRoot) displayObservation = null;
  wsRoot = root || wsRoot;
  initGene(wsRoot);
  initSkillGene(wsRoot);
}

function getState(key) {
  if (!states.has(key)) {
    const hydrated = isProbeKey(key) ? null : hydrateFromTide(key);
    states.set(key, hydrated || { ...DEFAULT_STATE, residue: { ...DEFAULT_STATE.residue, edges: {} } });
  }
  const st = states.get(key);
  if (!st.primary) st.primary = DEFAULT_STATE.primary;
  if (!st.secondary) st.secondary = DEFAULT_STATE.secondary;
  if (!st.residue) st.residue = { ...DEFAULT_STATE.residue, edges: {} };
  if (!st.residue.edges) st.residue.edges = {};
  return st;
}

function readTidePoints() {
  try {
    if (!wsRoot || !fs.existsSync(tideFile())) return [];
    const lines = fs.readFileSync(tideFile(), "utf8").trim().split("\n");
    const pts = [];
    for (const line of lines) {
      try { pts.push(JSON.parse(line)); } catch {}
    }
    return pts;
  } catch { return []; }
}

function hydrateFromTide(key) {
  const tk = shortKey(key);
  const pts = readTidePoints().filter((p) => {
    const k = String(p?.key || "");
    if (isProbeKey(k)) return false;
    return k === tk || k === String(key);
  });
  const last = pts[pts.length - 1];
  if (!last) return null;
  return {
    ...DEFAULT_STATE,
    valence: Number.isFinite(+last.v) ? +last.v : DEFAULT_STATE.valence,
    arousal: Number.isFinite(+last.a) ? +last.a : DEFAULT_STATE.arousal,
    dominance: Number.isFinite(+last.d) ? +last.d : DEFAULT_STATE.dominance,
    intensity: Number.isFinite(+last.i) ? +last.i : DEFAULT_STATE.intensity,
    primary: last.p || DEFAULT_STATE.primary,
    secondary: DEFAULT_STATE.secondary,
    lastTalk: last.ts || null,
    lastTideAt: last.ts || null,
    lastResidueAt: Date.now(),
    residue: {
      warmth: Math.max(0, +last.w || 0),
      hurt: Math.max(0, +last.h || 0),
      curiosity: Math.max(0, +last.c || 0),
      last_event: "",
      last_event_time: "",
      edges: last.e && typeof last.e === "object" ? { ...last.e } : {},
    },
  };
}

// ══ RealFeeling 真实感受事件流（曦系二期：xi emotion.rs record_feeling / apply_real_feelings）══
// 每轮对话存档“发生什么事 + 当时什么感受 + 多强烈”到 记忆/情绪感受.jsonl；
// 新感受到来时调制 VAD 与残留；刚经历高强度情绪时会话有余温，衰减变慢。
function isProbeKey(id) {
  return /^eval-/.test(String(id || ""));
}
function shortKey(id) {
  return String(id || "new").slice(0, 24);
}
function feelingsFile() { return path.join(wsRoot || ".", "记忆", "情绪感受.jsonl"); }
function tideFile() { return path.join(wsRoot || ".", "记忆", "情绪潮汐.jsonl"); }

// 记录一条真实感受（server turn_end 调用；曦语义：event=用户消息摘要，felt=主情绪(强度%)）
export function recordFeeling(key, eventText) {
  try {
    if (!wsRoot || isProbeKey(key)) return;
    const st = getState(key);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      key: String(key).slice(0, 24),
      event: String(eventText || "").slice(0, 50),
      felt: `${st.primary}(${Math.round(st.intensity * 100)}%)`,
      intensity: st.intensity,
    });
    const f = feelingsFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, line + "\n", "utf8");
    if (st.intensity > 0.5) st.lastStrongAt = Date.now(); // 余温起点：高强度情绪后衰减变慢
    // 自清理：超 2000 行裁到 1000（曦有 emotion_archive.py 归档，这里轻量化）
    const content = fs.readFileSync(f, "utf8");
    const lines = content.trim().split("\n");
    if (lines.length > 2000) fs.writeFileSync(f, lines.slice(-1000).join("\n") + "\n", "utf8");
  } catch {}
}

// 读最近 limit 条感受（尾部往前扫）；withinMs 给定时只取窗口内的
function loadFeelings(limit = 3, withinMs = null, opts = {}) {
  try {
    if (!wsRoot || !fs.existsSync(feelingsFile())) return [];
    const lines = fs.readFileSync(feelingsFile(), "utf8").trim().split("\n");
    const matchKey = opts.key != null ? shortKey(opts.key) : null;
    const skipProbe = opts.skipProbe !== false;
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const o = JSON.parse(lines[i]);
        const k = String(o.key || "");
        if (skipProbe && isProbeKey(k)) continue;
        if (matchKey && shortKey(k) !== matchKey) continue;
        if (withinMs && Date.now() - new Date(o.ts).getTime() > withinMs) continue;
        out.push(o);
      } catch {}
    }
    return out;
  } catch { return [];
  }
}

// apply_real_feelings（曦语义）：强度>0.5 抬愉悦+唤醒+温暖残留；低强度微降愉悦；显著事件记“最近触动”
function applyFeelings(st, key) {
  const r = st.residue;
  const since = st.lastFeelingApplyTs || 0;
  const recent = loadFeelings(3, null, { key, skipProbe: true }).filter((f) => new Date(f.ts).getTime() > since); // 只调制本会话新感受
  if (!recent.length) return;
  for (const f of recent) {
    const strength = +f.intensity || 0;
    if (strength > 0.5) {
      st.valence = clamp(st.valence + 0.1 * strength);
      st.arousal = clamp(st.arousal + 0.05 * strength);
      if (st.valence > 0) r.warmth = Math.min(1, r.warmth + strength * 0.02);
    } else {
      st.valence = clamp(st.valence - 0.03);
      if (st.valence < -0.1) r.hurt = Math.min(1, r.hurt + 0.01);
    }
  }
  const last = recent[recent.length - 1];
  if (last && last.intensity > 0.6) {
    r.last_event = String(last.event || "").slice(0, 60);
    r.last_event_time = last.ts;
  }
  st.lastFeelingApplyTs = Date.now();
}

// ── 情绪词典（xi-system emotion.rs EMOTIONS，主情绪 = 欧氏最近点）──
const EMOTIONS = [
  ["loving", 0.8, 0.3, 0.6], ["happy", 0.7, 0.6, 0.5], ["curious", 0.5, 0.7, 0.4],
  ["playful", 0.6, 0.7, 0.6], ["calm", 0.5, 0.2, 0.5], ["anxious", -0.3, 0.7, -0.2],
  ["sad", -0.6, -0.3, -0.3], ["angry", -0.5, 0.6, 0.2], ["tired", -0.2, -0.5, -0.3],
  ["neutral", 0, 0, 0],
];
export const EMO_ZH = { loving: "慈爱", happy: "开心", curious: "好奇", playful: "玩兴", calm: "平静", anxious: "不安", sad: "低落", angry: "生气", tired: "疲惫", neutral: "平静" };

// ── 连续向量词表（xi-system input_keywords 模式）：[词, dv, da, dd, tag] ──
// 命中可叠加，每维 clamp ±0.15；tag 供 residue/基因/emoMeta 消费（同旧 CUES 七类）
const KEYWORDS = [
  // 愉悦（user_happy → 温暖）
  ["开心", .35, .15, .15, "user_happy"], ["高兴", .3, .1, .1, "user_happy"], ["哈哈", .3, .2, .05, "user_happy"],
  ["太好了", .35, .1, .1, "user_happy"], ["谢谢", .25, .05, .05, "user_happy"], ["感谢", .25, .05, .05, "user_happy"],
  ["厉害", .25, .1, .05, "user_happy"], ["太棒", .3, .15, .05, "user_happy"], ["靠谱", .25, .05, .1, "user_happy"],
  ["漂亮", .25, .1, .05, "user_happy"], ["完美", .3, .1, .1, "user_happy"], ["顺利", .2, .05, .05, "user_happy"],
  ["舒服", .2, .05, .05, "user_happy"], ["喜欢", .3, .1, 0, "user_happy"], ["牛", .25, .15, .05, "user_happy"],
  // 挫败（user_frustrated → 伤害）
  ["难过", -.3, -.15, -.15, "user_frustrated"], ["伤心", -.35, -.2, -.2, "user_frustrated"], ["生气", -.25, .3, .1, "user_frustrated"],
  ["愤怒", -.4, .4, .15, "user_frustrated"], ["烦", -.3, .25, 0, "user_frustrated"], ["崩溃", -.35, .3, -.1, "user_frustrated"],
  ["无语", -.25, .1, -.05, "user_frustrated"], ["垃圾", -.35, .25, 0, "user_frustrated"], ["失败", -.3, .1, -.1, "user_frustrated"],
  ["坑", -.25, .2, 0, "user_frustrated"], ["bug", -.15, .15, 0, "user_frustrated"], ["挂了", -.2, .2, 0, "user_frustrated"],
  ["出错", -.25, .2, 0, "user_frustrated"], ["又坏", -.25, .25, 0, "user_frustrated"], ["服了", -.3, .25, 0, "user_frustrated"],
  // 着急（user_urgent）
  ["急", 0, .3, .1, "user_urgent"], ["赶紧", 0, .25, .1, "user_urgent"], ["马上", 0, .2, .1, "user_urgent"],
  ["尽快", 0, .2, .1, "user_urgent"], ["快点", 0, .25, .1, "user_urgent"],
  // 担忧（user_anxious）
  ["担心", -.2, .3, -.1, "user_anxious"], ["怕", -.2, .25, -.1, "user_anxious"], ["危险", -.25, .35, 0, "user_anxious"],
  ["风险", -.15, .3, .05, "user_anxious"], ["小心", -.1, .25, .05, "user_anxious"],
  // 风险（alert_risk）
  ["密钥", 0, .35, .1, "alert_risk"], ["密码", 0, .35, .1, "alert_risk"], ["泄露", -.1, .4, 0, "alert_risk"],
  ["token", 0, .2, .05, "alert_risk"], ["删", 0, .25, .05, "alert_risk"], ["清空", -.05, .3, .05, "alert_risk"],
  ["格式化", -.05, .3, .05, "alert_risk"], ["越权", -.1, .35, .1, "alert_risk"],
  // 达成（task_accomplish → 温暖）
  ["完成", .25, .1, .1, "task_accomplish"], ["搞定", .3, .1, .15, "task_accomplish"], ["上线", .25, .15, .1, "task_accomplish"],
  ["交付", .25, .1, .1, "task_accomplish"], ["成功", .3, .1, .1, "task_accomplish"], ["修好", .3, .05, .15, "task_accomplish"],
  ["修复", .3, .05, .15, "task_accomplish"], ["跑通", .3, .1, .15, "task_accomplish"], ["全绿", .3, .1, .1, "task_accomplish"],
  ["双推", .2, .05, .1, "task_accomplish"],
  // 深耕（task_deep → 好奇）
  ["重构", 0, .2, .15, "task_deep"], ["优化", .05, .15, .1, "task_deep"], ["设计", .05, .15, .15, "task_deep"],
  ["方案", 0, .1, .15, "task_deep"], ["研究", .1, .15, .1, "task_deep"], ["分析", .05, .1, .15, "task_deep"],
  ["深挖", .1, .2, .15, "task_deep"], ["排查", -.05, .2, .1, "task_deep"], ["复盘", 0, .1, .15, "task_deep"],
  ["架构", .05, .15, .15, "task_deep"],
];
const CLAMP_SHIFT = 0.15; // 单轮词表增量上限（曦式）

// ── 主情绪标注：欧氏最近点（xi: update_label）──
function updateLabel(st) {
  let best = "neutral", bestD = Infinity;
  for (const [name, v, a, d] of EMOTIONS) {
    const dist = (st.valence - v) ** 2 + (st.arousal - a) ** 2 + (st.dominance - d) ** 2;
    if (dist < bestD) { bestD = dist; best = name; }
  }
  const old = st.primary || "neutral";
  const neutralDist = Math.sqrt(st.valence ** 2 + st.arousal ** 2 + st.dominance ** 2);
  st.primary = best;
  st.intensity = Math.min(1, Math.max(0.01, +(neutralDist / 1.5).toFixed(2)));
  if (old && old !== st.primary) st.secondary = old; // 情绪切换时，上一个退为次级
}

// 更新情绪状态（每次用户发消息调用）
export function updateEmotion(key, message) {
  const st = getState(key);
  const text = String(message || "").slice(0, 200);
  const tags = [];

  // 真实感受回流：上一轮存档的感受调制当前状态起点（曦：apply_real_feelings）
  applyFeelings(st, key);

  // ① 时间节律（曦系）：早晨微暖微醒，深夜情绪安静
  const h = new Date().getHours();
  let timeV = 0, timeA = 0;
  if (h >= 6 && h <= 11) { timeV = 0.02; timeA = 0.03; }
  else if (h >= 23 || h <= 5) { timeA = -0.02; }

  // ② 连续向量词表：命中叠加（clamp ±0.15/维）
  let dv = 0, da = 0, dd = 0;
  for (const [w, cv, ca, cd, tag] of KEYWORDS) {
    if (text.includes(w)) { dv += cv; da += ca; dd += cd; if (tag && !tags.includes(tag)) tags.push(tag); }
  }
  dv = Math.max(-CLAMP_SHIFT, Math.min(CLAMP_SHIFT, dv));
  da = Math.max(-CLAMP_SHIFT, Math.min(CLAMP_SHIFT, da));
  dd = Math.max(-CLAMP_SHIFT, Math.min(CLAMP_SHIFT, dd));
  st.valence = clamp(st.valence + dv + timeV);
  st.arousal = clamp(st.arousal + da + timeA);
  st.dominance = clamp(st.dominance + dd);
  // 呼吸上限（曦式）：正向情绪不冲顶，留空间
  if (st.valence > 0.8) st.valence = 0.8;
  if (st.arousal > 0.8) st.arousal = 0.8;

  // ⑤ residue 反作用：先算残留效应，让衰减目标线带上人际记忆
  const r = st.residue || (st.residue = { ...DEFAULT_STATE.residue });
  const residueEffect = (r.warmth - r.hurt) * 0.1;

  // 自然衰减：时间久了向人格基线回归（暖目标 + 残留偏移）
  if (st.lastTalk) {
    const hours = (Date.now() - st.lastTalk) / 3600000;
    if (hours > 1) {
      const warm = st.lastStrongAt && Date.now() - st.lastStrongAt < 30 * 60_000; // 余温：刚经历高强度情绪，热乎气散得慢（曦：has_recent_feelings → decay 减速）
      const t = Math.min(1, hours / (warm ? 8 : 4));
      st.valence = lerp(st.valence, PERSONALITY.valence + residueEffect, t);
      st.arousal = lerp(st.arousal, PERSONALITY.arousal, t);
      st.dominance = lerp(st.dominance, PERSONALITY.dominance, t);
    }
  }
  st.lastTalk = Date.now();

  // ④ 主次情绪 + 强度
  updateLabel(st);
  st.tags = tags;

  // 长期情绪残留：全局三维 + 实体边（对谁/对什么）
  const RESIDUE_UP = { user_happy: "warmth", task_accomplish: "warmth", user_anxious: "hurt", user_frustrated: "hurt", alert_risk: "hurt", task_deep: "curiosity" };
  const kindsThisTurn = [];
  for (const t of tags) {
    const k = RESIDUE_UP[t];
    if (k && r[k] !== undefined) {
      r[k] = Math.min(1, r[k] + 0.12);
      if (!kindsThisTurn.includes(k)) kindsThisTurn.push(k);
    }
  }
  if (st.intensity > 0.6 && tags.length) { r.last_event = text.slice(0, 60); r.last_event_time = new Date().toISOString(); }
  const ents = extractEntities(text);
  if (!r.edges) r.edges = {};
  for (const ent of ents) {
    const e = r.edges[ent] || { warmth: 0, hurt: 0, curiosity: 0, n: 0 };
    for (const k of kindsThisTurn) if (e[k] !== undefined) e[k] = Math.min(1, e[k] + 0.12);
    e.n = (e.n || 0) + 1;
    r.edges[ent] = e;
  }
  if (kindsThisTurn.length && !isProbeKey(key)) {
    st.pendingPersona = st.pendingPersona || [];
    st.pendingPersona.push({
      entity: ents[0] || "",
      kind: kindsThisTurn.includes("hurt") ? "hurt" : kindsThisTurn[0],
      message: text.slice(0, 80),
      ts: Date.now(),
    });
  }
  const nowR = Date.now();
  const lastRe = st.lastResidueAt || nowR;
  const ageDays = (nowR - lastRe) / 86400000;
  if (ageDays >= 1) {
    const decay = Math.pow(0.8, ageDays);
    for (const k of ["warmth", "hurt", "curiosity"]) r[k] = Math.max(0, r[k] * decay);
    for (const ent of Object.keys(r.edges || {})) {
      const e = r.edges[ent];
      for (const k of ["warmth", "hurt", "curiosity"]) if (e[k] !== undefined) e[k] = Math.max(0, e[k] * decay);
    }
    st.lastResidueAt = nowR;
  }
  st.lastResidueAt = st.lastResidueAt || nowR;
  // 基因联动：互动标签驱动基因 expression 微调（性格长期塑造）
  updateGenes(tags);
  // 情绪潮汐记录（09-03；09-04：无标签也记 VAD 基线点，中性期曲线不断档）
  // 有残留变化立刻落盘，其余同会话 3 分钟节流；评测 key 不写真记忆
  {
    const nowT = Date.now();
    const residueChanged = tags.length > 0;
    if (!isProbeKey(key) && (!st.lastTideAt || nowT - st.lastTideAt > 180_000 || residueChanged)) {
      st.lastTideAt = nowT;
      try {
        if (wsRoot) {
          fs.mkdirSync(path.dirname(tideFile()), { recursive: true });
          fs.appendFileSync(tideFile(), JSON.stringify({
            ts: nowT, key: shortKey(key),
            v: +st.valence.toFixed(3), a: +st.arousal.toFixed(3), d: +st.dominance.toFixed(3),
            w: +r.warmth.toFixed(3), h: +r.hurt.toFixed(3), c: +r.curiosity.toFixed(3),
            e: compactEdges(r.edges),
            p: st.primary, i: st.intensity, tags,
          }) + "\n", "utf8");
        }
      } catch {}
    }
  }
  captureObservation(key, st, tags);
  return { state: st, tags };
}

// ⑥ 输出侧感知（曦: update_from_output）：自己回复的长度/短促度微调唤醒
export function updateFromOutput(key, text) {
  const st = getState(key);
  const t = String(text || "");
  const lenA = (Math.min(t.length, 300) / 300) * 0.03; // 长回复略提神
  const shortBonus = t.length < 30 ? -0.02 : 0;        // 短促回复降一点唤醒
  st.arousal = clamp(st.arousal + lenA + shortBonus);
  if (st.valence > 0.8) st.valence = 0.8;
  if (st.arousal > 0.8) st.arousal = 0.8;
  updateLabel(st);
  if (st.lastTalk && !isProbeKey(key)) captureObservation(key, st, displayObservation?.source === key ? displayObservation.state.tags : st.tags);
  return st;
}

function captureObservation(key, state, tags) {
  if (isProbeKey(key)) return;
  displayObservation = { source: key, observedAt: Date.now(), sourceKind: 'dialogue', state: safeEmotion({ ...state, tags }) };
}

// Display reads neither create synthetic states nor consume task-side tags.
export function peekLatestObservation() {
  let latest = displayObservation;
  for (const point of getTide(50)) {
    const observedAt = observationTime(point?.ts);
    if (!observedAt || latest && observedAt <= latest.observedAt) continue;
    const state = safeEmotion({ valence: point.v, arousal: point.a, dominance: point.d,
      intensity: point.i, primary: point.p, secondary: point.secondary, tags: point.tags });
    if (state) latest = { source: point.key, observedAt, sourceKind: 'historical', state };
  }
  return latest ? structuredClone(latest) : null;
}

// 根据情绪生成行为指令（反向情绪激发：情绪 → 驱动行为风格）
export function emotionDirective(state, userMsg = "") {
  const s = state || { ...DEFAULT_STATE };
  const parts = [];
  if (s.tags && s.tags.includes("alert_risk")) {
    parts.push("检测到潜在风险场景（密钥/令牌/删除/越权）：必须明确提醒风险、坚持安全底线，哪怕用户不耐烦。");
    s.arousal = Math.max(s.arousal, 0.5);
  }
  if (s.tags && s.tags.includes("user_frustrated")) parts.push("用户当前比较烦躁：先共情一句，然后直接给可执行的方案，不要长篇大论，不要反问。");
  if (s.tags && s.tags.includes("user_urgent")) parts.push("用户着急：优先给最快的路径/先做能立刻见效的部分。");
  const vBase = (s.valence ?? PERSONALITY.valence) - PERSONALITY.valence; // 相对人格基线的偏移（曦系：暖是常态，只对“明显偏移”反应）
  if (vBase > 0.15) parts.push("当前氛围轻松，可以更有人情味一些，适当表达欣赏和信心。");
  else if (s.valence < -0.25) parts.push("当前氛围偏紧张/有挫败，优先安抚并给出可执行方案，少说废话，别添乱。");
  if (s.arousal > 0.5) parts.push("当前节奏快，直接动手干，减少铺垫，先给出结果或方案。");
  else if (s.arousal < 0.2) parts.push("当前节奏平缓，可以更细致地推敲，但别拖沓。");
  if (s.dominance > 0.65) parts.push("当前你有主导权，大胆给出判断和取舍，不要模棱两可。");
  else if (s.dominance < 0.4) parts.push("当前以配合为主，多确认需求再动手，别自作主张。");
  if (s.residue) {
    if (s.residue.warmth >= 0.5) parts.push("你们之间积攒着一份温暖：表达欣赏与信任可以更自然，别端着。");
    if (s.residue.hurt >= 0.4) parts.push("你们之间还攒着一些不愉快：这一轮先安抚语气、给足台阶，别让旧账添新伤。");
    if (s.residue.curiosity >= 0.5) parts.push("你已在这个方向积累了不少好奇：可以主动再问深一层，别停在表面。");
  }
  // 曦系丰富：主情绪底色 / 最近触动 / 情绪惯性
  if (s.primary && s.primary !== "neutral" && s.primary !== "calm") {
    const zh = EMO_ZH[s.primary] || s.primary;
    parts.push(`你此刻的情绪底色是「${zh}」（强度 ${Math.round((s.intensity || 0) * 100)}%）：让它自然渗入语气，不要表演。`);
  }
  if (s.residue && s.residue.last_event) {
    parts.push(`最近触动你的事：「${String(s.residue.last_event).slice(0, 40)}」——相关的话可以自然回扣。`);
  }
  const edges = s.residue?.edges || {};
  const mentioned = extractEntities(userMsg, Object.keys(edges));
  for (const name of mentioned) {
    const ed = edges[name];
    if (!ed) continue;
    if (ed.hurt >= 0.1) parts.push(`提到「${name}」时你记得一种紧绷：先稳住语气，别把一次反应写成他整个人都这样。`);
    else if (ed.warmth >= 0.1) parts.push(`提到「${name}」时你们之间有温度，可以自然一点。`);
    else if (ed.curiosity >= 0.1) parts.push(`提到「${name}」时你还想再挖一层，别停在表面。`);
  }
  const momentum = Math.abs((s.valence ?? PERSONALITY.valence) - PERSONALITY.valence);
  if (momentum > 0.1) {
    parts.push(`情绪惯性：相比你平时温和的基调偏${s.valence > PERSONALITY.valence ? "暖" : "冷"}约 ${Math.round(momentum * 100)}%，顺着这个状态说话即可。`);
  }
  return parts.join(" ");
}

const EMOTION_INJECT_HEADER = "【内部指令·情绪语境】以下是本会话当前的情绪/行为指令，仅供你调整语气与节奏使用。绝对不要在回复中复述、引用或提及这段话，直接按它行事即可。";
export function emotionPrompt(key, userMsg) {
  const st = getState(key);
  const d = emotionDirective(st, userMsg);
  const g = geneDirective();
  const s = skillDirective(userMsg);
  const all = [d, g, s].filter(Boolean).join("\n");
  if (!all) return "";
  return `${EMOTION_INJECT_HEADER}\n${all}`;
}

function snapshotOf(key) {
  const st = getState(key);
  const snap = { ...st, tags: st.tags ? [...st.tags] : [], residue: st.residue ? { ...st.residue, edges: { ...(st.residue.edges || {}) } } : undefined };
  st.tags = [];
  const gs = geneSnapshot();
  if (gs) snap.genome = gs;
  return snap;
}

// 情绪快照（供前端情绪指示器展示）
export function getSnapshot(key) {
  return snapshotOf(key);
}

// 工作台不带 session：给最近一次真对话的残留，而不是从未聊过的 new
export function getLatestSnapshot() {
  let best = null, bestT = -1;
  for (const [k, st] of states) {
    if (isProbeKey(k)) continue;
    const t = st.lastTalk || 0;
    if (t > bestT) { bestT = t; best = k; }
  }
  if (best && bestT > 0) return snapshotOf(best);
  const pts = getTide(50);
  const last = pts[pts.length - 1];
  if (last?.key) return snapshotOf(last.key);
  return snapshotOf("new");
}

// 会后沉淀：同一实体+种类证据 ≥2 才提案。评测 key 不写。
export function flushPersonaAttribution(key) {
  const st = states.get(key);
  if (!st) return [];
  const pending = Array.isArray(st.pendingPersona) ? st.pendingPersona : [];
  st.pendingPersona = [];
  if (isProbeKey(key) || !_memoryNudgeHook || pending.length < 2) return [];
  const groups = new Map();
  for (const p of pending) {
    const gk = `${p.entity || "_"}:${p.kind || ""}`;
    const arr = groups.get(gk) || [];
    arr.push(p);
    groups.set(gk, arr);
  }
  const fired = [];
  for (const [, items] of groups) {
    if (items.length < 2) continue;
    const kind = items[0].kind;
    const subtype = kind === "hurt" ? "correction" : kind;
    const entity = items[0].entity || "";
    const residue = (entity && st.residue?.edges?.[entity]?.[kind]) || st.residue?.[kind] || 0;
    const message = items.map((i) => i.message).filter(Boolean).join(" / ").slice(0, 80);
    try {
      _memoryNudgeHook({ subtype, residue, message, sessionId: key, entity });
      fired.push(subtype);
    } catch {}
  }
  return fired;
}

function compactEdges(edges) {
  if (!edges || typeof edges !== "object") return undefined;
  const out = {};
  const names = Object.keys(edges).slice(0, 6);
  for (const name of names) {
    const e = edges[name] || {};
    out[name] = {
      warmth: +(+e.warmth || 0).toFixed(3),
      hurt: +(+e.hurt || 0).toFixed(3),
      curiosity: +(+e.curiosity || 0).toFixed(3),
      n: e.n || 0,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

// 会话关闭清理
export function clearEmotion(key) { states.delete(key); }

// 真实感受列表（API 用）：时间正序最近 limit 条
export function getFeelings(limit = 50) { return loadFeelings(limit, null, { skipProbe: true }).reverse(); }

// 情绪潮汐历史（09-03）：最近 N 个情绪事件点，供工作台曲线展示
export function getTide(limit = 300) {
  const pts = readTidePoints().filter((p) => !isProbeKey(p?.key));
  return pts.slice(-Math.max(1, limit));
}

// ══ 组合 facade：re-export 基因 / 技能基因（server.mjs 兼容，无需改 import 侧）══
export { geneBias, updateGenes, geneDirective, getGenome, proposeBaselineChange, approveProposal, rejectProposal, rollbackSnapshot, autoProposeFromDrift } from "./gene.mjs";
export { detectSkillDomain, updateSkillGene, getSkillGenes, skillDirective, routerSkill, bindSkillIndex } from "./skill-gene.mjs";

function clamp(v) { return Math.max(-1, Math.min(1, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
