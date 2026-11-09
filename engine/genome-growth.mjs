// engine/genome-growth.mjs —— 5 维成长 + 换代提案 + 人批准/回滚（2026-11-09，曦 GRN 最后一层）
//
// 来源与"故意不同"：
//   D:\xinyu\kernel\heart.py:139-191 GrowthState.advance()
//     —— 5 维（陪伴/理解/判断/承担/治理）逐轮累积 deltas，五维全满 → **自动**晋升一代，
//        旧值归档进 generations[]，然后 5 维重置成 0.30。
//   本模块**不自动换代**：曦是"满级自动晋升"，元枢必须走人批准——换代是人格级变化。
//     五维满级 → 生成「换代提案」（理由/旧值/新值/drift）→ 落 pending 等人批准
//       → 人批准（human-confirm:）→ generation+1，旧 dims + 基因快照归档进 generations[]
//       → 人拒绝 → 保持原代、提案进 history 留痕、50 轮冷却（不会下一轮又弹一次）
//       → 回滚 → generations 弹栈，generation/dims 回到上一代（同样要人确认）
//
// 5 维不是随机数、不是常量，逐维来源（都可解释、拿不到就 skipped）：
//   陪伴 companion      ← 关系层 记忆/运行时/关系.json 的 interactions（已聊次数） / 200
//   理解 understanding  ← 记忆/纠正记忆.md 里**去重后**的纠正条数 / 20
//                         （同一句话纠正十次只算一条：复犯不给成长；用户澄清次数无台账 → skipped）
//   判断 judgment       ← 记忆/运行时/交付门.json 的 GREEN 比例 × 样本置信（20 条才满信），≥5 条样本才判
//   承担 responsibility ← 值班日志 值班日志-*.jsonl 里 wake_done 次数 / 30（watch/dispatch 真的跑完的产出）
//   治理 governance     ← 最近 200 轮里的红线拦截次数：每次 −0.2（拦截后不再犯，才能慢慢洗回 1.0）
//
// 累积规则（两条硬约束，防止"一次暴增"和"永不满级"都失控）：
//   ① 单轮每维增量 ≤ MAX_STEP(0.02)：不管来源数字跳多少，一轮最多涨 2%；
//   ② 每维封顶 1.0：growth 只增不减（成长不是记分牌；回落由下一代的 baseline 承担）。
//   当前值 = 已知量 / 归一化上限（CAPS）；目标值 = min(1, 已知量/上限)，
//   实际增量 = clamp(目标 − 当前, 0, MAX_STEP)：数据没到就等着，不提前给分。
//
// 落盘：记忆/运行时/成长.json（原子写，复用 engine/atomic-io.mjs）。
// 不写 记忆/harness/、不碰人格定义.json（人格定义仍是只读 prompt 层）。
// 不做定时器：只有一轮对话结束（unified-chat 轮末）或人点 API 才会推进。

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./atomic-io.mjs";
import {
  current as genomeCurrent,
  drift as genomeDrift,
  filePath as genomeFilePath,
  setGeneration as genomeSetGeneration,
} from "./genome.mjs";

export const FILE_REL = path.join("记忆", "运行时", "成长.json");

export const DIMS = Object.freeze(["companion", "understanding", "judgment", "responsibility", "governance"]);
export const DIM_LABELS = Object.freeze({
  companion: "陪伴",
  understanding: "理解",
  judgment: "判断",
  responsibility: "承担",
  governance: "治理",
});

// 单轮每维增量上限（防一次暴增）。调大 = 成长更快，也更容易被一轮异常数据带走。
export const MAX_STEP = 0.02;
// 换代重置：全维 −RESET_DROP，保留底子；但不低于 RESET_FLOOR。
// 因为只有全维 1.0 才会提案，实际效果 = 每代从 0.5 起（想拉平代际速度就把 RESET_DROP 调到 0.8）。
export const RESET_DROP = 0.5;
export const RESET_FLOOR = 0.2;
// 拒绝/回滚后的冷却：满级状态还在，没有冷却会"下一轮立刻再弹一次提案"。
export const PROPOSAL_COOLDOWN_TURNS = 50;
// 治理窗口与单次拦截扣分：窗口内每次红线拦截扣 0.2（5 次扣到 0），过了窗口才洗掉。
export const GOVERNANCE_WINDOW = 200;
export const GOVERNANCE_PENALTY = 0.2;
export const MIN_GOVERNANCE_TURNS = 20;
// 判断：交付门样本门槛与"满信"样本数，以及 GREEN 比例达到多少算满值。
// 不要求 100% GREEN：满级是"判断力稳定"，不是"一次 RED 都不能有"——
// 要求 100% 会让一次误判把这一维永远压在 1.0 以下（最近 50 条里那条 RED 要 50 条新 GREEN 才洗得掉）。
export const MIN_JUDGMENT_SAMPLES = 5;
export const JUDGMENT_FULL_CONFIDENCE = 20;
export const JUDGMENT_FULL_RATIO = 0.9;
// 归一化上限（当前值 = 已知量 / 上限）。
export const CAPS = Object.freeze({
  companion: 200,
  understanding: 20,
  responsibility: 30,
});

const RELATION_FILE = path.join("记忆", "运行时", "关系.json");
const CORRECTION_FILE = path.join("记忆", "纠正记忆.md");
const DELIVERY_FILE = path.join("记忆", "运行时", "交付门.json");
const RUNTIME_DIR = path.join("记忆", "运行时");
const WATCH_LOG_RE = /^值班日志.*\.jsonl$/;
const WATCH_TAIL_BYTES = 256 * 1024;
const WATCH_TAIL_FILES = 3;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round4 = (v) => Math.round((Number(v) + Number.EPSILON) * 1e4) / 1e4;
const iso = (now) => {
  const n = Number(now);
  return new Date(Number.isFinite(n) ? n : Date.now()).toISOString();
};
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);

let wsRoot = "";
let cache = null;
let cacheRoot = null; // null = 还没缓存过（"" 是合法根，不能当哨兵）
let memory = defaultState();

function defaultDims() {
  return Object.fromEntries(DIMS.map((d) => [d, 0]));
}

function defaultState() {
  return {
    dims: defaultDims(),
    generation: 0,
    generations: [],
    pending: null,
    baseline: null,
    history: [],
    evidence: { turns: 0, guardBlocks: 0, guardWindow: [] },
    cooldownUntilTurn: 0,
    updatedAt: null,
  };
}

const clone = (st) => structuredClone(st);

function normalizeDims(input) {
  const o = input && typeof input === "object" ? input : {};
  const out = {};
  for (const d of DIMS) out[d] = clamp01(Number.isFinite(+o[d]) ? +o[d] : 0);
  return out;
}

function normalizeGenes(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {};
  for (const [k, v] of Object.entries(input)) if (Number.isFinite(+v)) out[String(k)] = +v;
  return Object.keys(out).length ? out : null;
}

function normalizeProposal(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = str(raw.id, 120);
  if (!id) return null;
  const from = Math.floor(Number(raw.fromGeneration));
  return {
    ...raw,
    id,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    fromGeneration: Number.isFinite(from) && from >= 0 ? from : 0,
    toGeneration: (Number.isFinite(from) && from >= 0 ? from : 0) + 1,
    reason: str(raw.reason),
    dims: normalizeDims(raw.dims),
    nextDims: normalizeDims(raw.nextDims ?? resetDims(raw.dims)),
    genes: normalizeGenes(raw.genes),
    drift: raw.drift && typeof raw.drift === "object" ? raw.drift : null,
  };
}

function normalizeState(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const dims = normalizeDims(o.dims);
  const gen = Math.floor(Number(o.generation));
  const generations = Array.isArray(o.generations)
    ? o.generations
        .filter((g) => g && typeof g === "object" && !Array.isArray(g))
        .slice(-50)
        .map((g) => {
          const gen = Math.floor(Number(g.gen));
          return {
            gen: Number.isFinite(gen) && gen >= 0 ? gen : 0,
            dims: normalizeDims(g.dims),
            genes: normalizeGenes(g.genes),
            at: typeof g.at === "string" ? g.at : null,
            approvedBy: str(g.approvedBy, 160),
            reason: str(g.reason),
            proposalId: str(g.proposalId, 120),
          };
        })
    : [];
  const ev = o.evidence && typeof o.evidence === "object" ? o.evidence : {};
  const turns = Math.floor(Number(ev.turns));
  const guardWindow = Array.isArray(ev.guardWindow)
    ? ev.guardWindow.map((t) => Math.floor(Number(t))).filter((t) => Number.isFinite(t) && t > 0).slice(-GOVERNANCE_WINDOW)
    : [];
  const baseline = o.baseline && typeof o.baseline === "object" && !Array.isArray(o.baseline)
    ? {
        dims: normalizeDims(o.baseline.dims),
        genes: normalizeGenes(o.baseline.genes),
        at: typeof o.baseline.at === "string" ? o.baseline.at : null,
        approvedBy: str(o.baseline.approvedBy, 160),
        generation: Math.max(0, Math.floor(Number(o.baseline.generation) || 0)),
      }
    : null;
  const history = Array.isArray(o.history)
    ? o.history.filter((h) => h && typeof h === "object" && !Array.isArray(h)).slice(-50)
    : [];
  const cooldown = Math.floor(Number(o.cooldownUntilTurn));
  return {
    dims,
    generation: Number.isFinite(gen) && gen >= 0 ? gen : 0,
    generations,
    pending: normalizeProposal(o.pending),
    baseline,
    history,
    evidence: {
      turns: Number.isFinite(turns) && turns >= 0 ? turns : 0,
      guardBlocks: Math.max(0, Math.floor(Number(ev.guardBlocks) || 0)),
      guardWindow,
    },
    cooldownUntilTurn: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 0,
    updatedAt: typeof o.updatedAt === "string" && o.updatedAt ? o.updatedAt : null,
  };
}

/** 工作区根。服务启动时由 engine/emotion.mjs 的 init 调一次；测试里每个临时目录调一次。 */
export function init(root) {
  const next = root == null ? "" : String(root);
  if (next !== wsRoot) {
    cache = null;
    cacheRoot = null;
    memory = defaultState();
  }
  wsRoot = next;
}

export function filePath() {
  return wsRoot ? path.join(wsRoot, FILE_REL) : "";
}

function load() {
  if (!wsRoot) return memory;
  if (cache && cacheRoot === wsRoot) return cache;
  let raw = null;
  try {
    const f = filePath();
    if (f && fs.existsSync(f)) raw = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { raw = null; } // 坏文件按默认值起，下一轮写盘自然修复；不阻塞聊天
  cache = normalizeState(raw);
  cacheRoot = wsRoot;
  return cache;
}

function save(st) {
  memory = clone(st);
  cache = memory;
  cacheRoot = wsRoot;
  const f = filePath();
  if (!f) return false;
  try { atomicWriteJson(f, memory); return true; } catch { return false; }
}

/** 当前状态快照（深拷贝，调用方改不到内存态）。 */
export function current() {
  return clone(load());
}

/** 换代重置规则（纯函数，可单测）：全维 −RESET_DROP，保留底子但不低于 RESET_FLOOR。 */
export function resetDims(dims) {
  const src = dims && typeof dims === "object" ? dims : {};
  const out = {};
  for (const d of DIMS) {
    const v = Number.isFinite(+src[d]) ? +src[d] : 0;
    out[d] = round4(Math.max(RESET_FLOOR, Math.min(1, v - RESET_DROP)));
  }
  return out;
}

// ── 信号读取（全部只读；每一项单独 try/catch，坏文件只影响自己那一维）──────────

function readJsonFile(abs) {
  try {
    if (!abs || !fs.existsSync(abs)) return null;
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch { return null; }
}

function readTextFile(abs) {
  try {
    if (!abs || !fs.existsSync(abs)) return "";
    return fs.readFileSync(abs, "utf8");
  } catch { return ""; }
}

/** 读文件尾部若干字节并按行切（值班日志可能到 2MB，不要整份读进来）。 */
function readTailLines(abs, maxBytes = WATCH_TAIL_BYTES) {
  let fd = null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size <= 0) return [];
    const start = Math.max(0, st.size - maxBytes);
    const size = st.size - start;
    const buf = Buffer.alloc(size);
    fd = fs.openSync(abs, "r");
    const read = fs.readSync(fd, buf, 0, size, start);
    return buf.subarray(0, read).toString("utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
}

/** 纠正记忆：按 ### 分块，取「纠正:」；同一句话只说一次算数（复犯不涨理解）。 */
export function parseCorrections(text) {
  const raw = String(text || "");
  const all = [];
  for (const block of raw.split(/\n(?=###\s)/)) {
    const lines = block.split(/\r?\n/);
    const body = [];
    for (const line of lines) {
      const m = line.match(/^\s*-\s*(?:同场|追加)?纠正:\s*(.+)$/);
      if (m) body.push(m[1]);
    }
    const text2 = (body.length ? body : lines.filter((l) => /纠正:/.test(l)).map((l) => l.replace(/^.*?纠正:\s*/, "")))
      .map((s) => s.trim())
      .filter(Boolean)
      .join("；");
    if (text2) all.push(text2);
  }
  const unique = [];
  const seen = new Set();
  for (const item of all) {
    const key = item.replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return { total: all.length, unique: unique.length, distinct: unique };
}

function watchLogFiles() {
  try {
    const dir = path.join(wsRoot, RUNTIME_DIR);
    const names = fs.readdirSync(dir).filter((n) => WATCH_LOG_RE.test(n)).sort();
    return names.slice(-WATCH_TAIL_FILES).map((n) => path.join(dir, n));
  } catch { return []; }
}

/**
 * 按已有台账测 5 维的"已知量 / 归一化上限"。
 * 纯只读：不改状态、不落盘；拿不到的维度不出现在 values 里，只在 skipped 里说明。
 * @returns {{values:object, sources:object, skipped:string[]}}
 */
export function measure({ state = null, caps = CAPS } = {}) {
  const st = state && typeof state === "object" ? state : load();
  const values = {};
  const sources = {};
  const skipped = [];

  if (!wsRoot) {
    skipped.push("（跳过）5 维全部：成长层未初始化工作区");
    return { values, sources, skipped };
  }

  // ① 陪伴 ← 关系层 interactions
  try {
    const rel = readJsonFile(path.join(wsRoot, RELATION_FILE));
    const interactions = Math.max(0, Math.floor(Number(rel?.interactions) || 0));
    if (interactions > 0) {
      const v = clamp01(interactions / Math.max(1, Number(caps.companion) || CAPS.companion));
      values.companion = v;
      sources.companion = {
        signal: "关系层 interactions（已聊次数）",
        raw: interactions,
        cap: Number(caps.companion) || CAPS.companion,
        measured: round4(v),
        file: RELATION_FILE.replace(/\\/g, "/"),
      };
    } else {
      skipped.push("（跳过）陪伴：关系层没有互动记录（记忆/运行时/关系.json 不存在或 interactions=0）");
    }
  } catch (e) {
    skipped.push(`（跳过）陪伴：关系层读取失败（${str(e?.message, 80)}）`);
  }

  // ② 理解 ← 纠正记忆去重条数
  try {
    const parsed = parseCorrections(readTextFile(path.join(wsRoot, CORRECTION_FILE)));
    if (parsed.total > 0) {
      const v = clamp01(parsed.unique / Math.max(1, Number(caps.understanding) || CAPS.understanding));
      values.understanding = v;
      sources.understanding = {
        signal: "纠正记忆去重条数",
        raw: parsed.unique,
        total: parsed.total,
        repeats: Math.max(0, parsed.total - parsed.unique),
        cap: Number(caps.understanding) || CAPS.understanding,
        measured: round4(v),
        file: "记忆/纠正记忆.md",
      };
    } else {
      skipped.push("（跳过）理解：纠正记忆为空或不存在（记忆/纠正记忆.md）");
    }
    sources.understandingAlternative = {
      signal: "用户澄清次数",
      skipped: true,
      note: "没有澄清台账（clarification log），不参与计算",
    };
    skipped.push("（跳过）理解·用户澄清次数：没有澄清台账，不参与计算");
  } catch (e) {
    skipped.push(`（跳过）理解：纠正记忆读取失败（${str(e?.message, 80)}）`);
  }

  // ③ 判断 ← 交付门 GREEN 比例 × 样本置信
  try {
    const ledger = readJsonFile(path.join(wsRoot, DELIVERY_FILE));
    const items = Array.isArray(ledger?.items) ? ledger.items.slice(-50) : [];
    const total = items.length;
    const green = items.filter((x) => String(x?.verdict || "").toUpperCase() === "GREEN").length;
    if (total >= MIN_JUDGMENT_SAMPLES) {
      const ratio = green / total;
      const confidence = Math.min(1, total / JUDGMENT_FULL_CONFIDENCE);
      const v = clamp01((ratio / JUDGMENT_FULL_RATIO) * confidence);
      values.judgment = v;
      sources.judgment = {
        signal: "交付门 GREEN 比例 × 样本置信",
        raw: `${green}/${total}`,
        green,
        total,
        ratio: round4(ratio),
        fullRatio: JUDGMENT_FULL_RATIO,
        confidence: round4(confidence),
        measured: round4(v),
        samplesNeeded: MIN_JUDGMENT_SAMPLES,
        fullConfidenceSamples: JUDGMENT_FULL_CONFIDENCE,
        file: "记忆/运行时/交付门.json",
      };
    } else {
      skipped.push(`（跳过）判断：交付门只有 ${total} 条判定（需 ≥${MIN_JUDGMENT_SAMPLES} 条才判）`);
    }
    // 工具成功率：有审计台账时只当旁证给出来，不混进上面那个公式（口径不同，混算会失去可解释性）。
    try {
      const lines = readTailLines(path.join(wsRoot, RUNTIME_DIR, "动作审计.jsonl"));
      let ok = 0, failed = 0;
      for (const line of lines) {
        let row = null;
        try { row = JSON.parse(line); } catch { continue; }
        if (row?.phase !== "after") continue;
        if (row?.ok === true) ok += 1;
        else if (row?.ok === false) failed += 1;
      }
      if (ok + failed >= MIN_JUDGMENT_SAMPLES) {
        sources.judgmentAlternative = {
          signal: "工具成功率（旁证）",
          ok,
          failed,
          rate: round4(ok / (ok + failed)),
          note: "只作旁证，不参与判断维度计算",
        };
      }
    } catch {}
  } catch (e) {
    skipped.push(`（跳过）判断：交付门台账读取失败（${str(e?.message, 80)}）`);
  }

  // ④ 承担 ← 值班日志 wake_done
  try {
    const files = watchLogFiles();
    if (files.length) {
      let done = 0, failed = 0;
      for (const file of files) {
        for (const line of readTailLines(file)) {
          let row = null;
          try { row = JSON.parse(line); } catch { continue; }
          if (row?.event === "wake_done") done += 1;
          else if (row?.event === "wake_error") failed += 1;
        }
      }
      const v = clamp01(done / Math.max(1, Number(caps.responsibility) || CAPS.responsibility));
      values.responsibility = v;
      sources.responsibility = {
        signal: "值班日志 wake_done（watch/dispatch 跑完的次数）",
        raw: done,
        failed,
        cap: Number(caps.responsibility) || CAPS.responsibility,
        measured: round4(v),
        files: files.length,
      };
    } else {
      skipped.push("（跳过）承担：没有值班日志（记忆/运行时/值班日志-*.jsonl），watch/dispatch 还没产出");
    }
  } catch (e) {
    skipped.push(`（跳过）承担：值班日志读取失败（${str(e?.message, 80)}）`);
  }

  // ⑤ 治理 ← 最近 GOVERNANCE_WINDOW 轮里的红线拦截次数（advance 记在 evidence）
  try {
    const ev = st?.evidence && typeof st.evidence === "object" ? st.evidence : {};
    const turns = Math.max(0, Math.floor(Number(ev.turns) || 0));
    const blocks = Array.isArray(ev.guardWindow) ? ev.guardWindow.filter((t) => turns - Number(t) < GOVERNANCE_WINDOW).length : 0;
    if (turns >= MIN_GOVERNANCE_TURNS || blocks > 0) {
      const v = clamp01(1 - blocks * GOVERNANCE_PENALTY);
      values.governance = v;
      sources.governance = {
        signal: "最近红线拦截次数（拦截后不再犯才洗回 1.0）",
        blocks,
        turns,
        window: GOVERNANCE_WINDOW,
        penalty: GOVERNANCE_PENALTY,
        measured: round4(v),
        note: blocks === 0 ? "窗口内没有被红线拦过" : `窗口内被拦 ${blocks} 次`,
      };
    } else {
      skipped.push(`（跳过）治理：只跑了 ${turns} 轮（需 ≥${MIN_GOVERNANCE_TURNS} 轮或至少一次拦截记录）`);
    }
  } catch (e) {
    skipped.push(`（跳过）治理：状态读取失败（${str(e?.message, 80)}）`);
  }

  return { values, sources, skipped };
}

function geneSnapshot() {
  try {
    if (!genomeFilePath()) return null; // 基因层没初始化：不伪造 10 个默认值当快照
    const genes = genomeCurrent()?.genes;
    return genes && typeof genes === "object" ? { ...genes } : null;
  } catch { return null; }
}

function driftSnapshot() {
  try {
    if (!genomeFilePath()) return null;
    const d = genomeDrift();
    return {
      worst: d?.worst ? { key: str(d.worst.key, 40), drift: round4(d.worst.drift), threshold: round4(d.worst.threshold) } : null,
      withinAll: d?.withinAll === true,
    };
  } catch { return null; }
}

function makeProposal(st, { reason, now, genes, drift }) {
  const from = st.generation;
  const to = from + 1;
  return {
    id: `growth-${to}-${Date.parse(now) || Date.now()}`,
    createdAt: now,
    fromGeneration: from,
    toGeneration: to,
    reason: str(reason || "五维满级"),
    dims: { ...st.dims },
    nextDims: resetDims(st.dims),
    genes: genes || null,
    drift: drift || null,
    evidence: { turns: st.evidence.turns, guardBlocks: st.evidence.guardBlocks },
  };
}

/**
 * 推进一轮。
 * @param {object|null} deltas 显式增量（每维夹在 0..MAX_STEP，负数不生效）；
 *                             传 null/undefined → 按信号台账自动测（推荐，接线走这条）。
 * @param {{reason?:string, now?:number, guardBlocks?:number}} opts
 *        guardBlocks = 自上一轮结算以来被红线拦下的次数（genome.advanceTurn 的返回值）。
 * @returns {{ok:boolean, promoted:false, pending:boolean, proposal:object|null, proposed:boolean, ...}}
 *          五维全满时 promoted 恒为 false —— 只生成提案，绝不自动换代。
 */
export function advance(deltas = null, { reason = "", now = Date.now(), guardBlocks = 0 } = {}) {
  const st = load();
  const at = iso(now);
  const turn = (Number.isFinite(+st.evidence.turns) ? st.evidence.turns : 0) + 1;
  st.evidence.turns = turn;
  const blocks = Math.max(0, Math.floor(Number(guardBlocks) || 0));
  st.evidence.guardBlocks += blocks;
  for (let i = 0; i < blocks; i++) st.evidence.guardWindow.push(turn);
  st.evidence.guardWindow = st.evidence.guardWindow
    .filter((t) => turn - t < GOVERNANCE_WINDOW)
    .slice(-GOVERNANCE_WINDOW);

  let measured = null;
  let skipped = [];
  const inc = Object.fromEntries(DIMS.map((d) => [d, 0]));

  if (deltas && typeof deltas === "object" && !Array.isArray(deltas)) {
    // 显式增量：仍然受单轮上限约束（传 5 也只涨 0.02；负数当作 0，成长不倒退）
    for (const d of DIMS) inc[d] = clamp01(Math.min(MAX_STEP, Math.max(0, Number(deltas[d]) || 0)));
  } else {
    const m = measure({ state: st });
    measured = m.values;
    skipped = m.skipped;
    for (const d of DIMS) {
      if (!(d in m.values)) continue;
      inc[d] = clamp01(Math.min(MAX_STEP, Math.max(0, m.values[d] - st.dims[d])));
    }
  }

  for (const d of DIMS) st.dims[d] = Math.min(1, round4(st.dims[d] + inc[d]));

  const allMaxed = DIMS.every((d) => st.dims[d] >= 1);
  let proposed = false;
  if (allMaxed && !st.pending && turn >= (Number(st.cooldownUntilTurn) || 0)) {
    st.pending = makeProposal(st, { reason, now: at, genes: geneSnapshot(), drift: driftSnapshot() });
    proposed = true;
  }

  st.updatedAt = at;
  save(st);
  const state = clone(st);
  return {
    ok: true,
    promoted: false, // 永不自动换代
    pending: Boolean(st.pending),
    proposal: st.pending ? clone(st.pending) : null,
    proposed,
    generation: st.generation,
    dims: { ...st.dims },
    deltas: { ...inc },
    measured,
    skipped,
    state,
  };
}

function requireHuman(approvedBy, action) {
  const who = String(approvedBy || "");
  if (!who.startsWith("human-confirm:")) {
    return {
      ok: false,
      error: `${action}必须有人批准（approvedBy 需以 human-confirm: 开头，照 persona-governance 的既有约定）`,
      code: "human_confirm_required",
    };
  }
  return null;
}

/**
 * 人批准换代：generation+1，旧 dims + 基因快照归档进 generations[]，
 * dims 按 resetDims() 重置（新 baseline = 重置后的当前值）。
 * @returns {{ok:boolean, promoted:boolean, generation?:number, archived?:object, error?:string}}
 */
export function promote({ approvedBy = "", reason = "", now = Date.now() } = {}) {
  const denied = requireHuman(approvedBy, "换代");
  if (denied) return { ...denied, promoted: false };
  const st = load();
  if (!st.pending) return { ok: false, promoted: false, error: "没有待批的换代提案", code: "no_pending_proposal" };

  const at = iso(now);
  const who = String(approvedBy);
  const genes = geneSnapshot();
  const proposal = clone(st.pending);
  const archived = {
    gen: st.generation,
    dims: { ...st.dims },
    genes,
    at,
    approvedBy: who,
    reason: str(reason || proposal.reason),
    proposalId: proposal.id,
  };
  st.generations.push(archived);
  st.generation += 1;
  st.dims = resetDims(archived.dims);
  st.pending = null;
  st.cooldownUntilTurn = 0;
  st.baseline = { dims: { ...st.dims }, genes: genes || null, at, approvedBy: who, generation: st.generation };
  st.history.push({
    at,
    action: "promote",
    generation: st.generation,
    by: who,
    reason: archived.reason,
    proposalId: proposal.id,
    dims: archived.dims,
    nextDims: { ...st.dims },
  });
  st.updatedAt = at;
  save(st);

  let genome = null;
  try {
    if (genomeFilePath()) genome = genomeSetGeneration(st.generation, { genes, approvedBy: who, now });
  } catch {}

  return {
    ok: true,
    promoted: true,
    generation: st.generation,
    dims: { ...st.dims },
    archived,
    proposal,
    baseline: clone(st.baseline),
    genome,
    state: clone(st),
  };
}

/**
 * 人拒绝换代：保持原代；提案进 history 留痕；进入冷却，免得下一轮又弹同一条。
 */
export function reject({ by = "", reason = "", now = Date.now() } = {}) {
  const st = load();
  if (!st.pending) return { ok: false, rejected: false, error: "没有待批的换代提案", code: "no_pending_proposal" };
  const at = iso(now);
  const proposal = clone(st.pending);
  const who = str(by || "operator", 160) || "operator";
  st.history.push({
    at,
    action: "reject",
    generation: st.generation,
    by: who,
    reason: str(reason),
    proposalId: proposal.id,
    proposal: {
      id: proposal.id,
      createdAt: proposal.createdAt,
      fromGeneration: proposal.fromGeneration,
      toGeneration: proposal.toGeneration,
      reason: proposal.reason,
      dims: proposal.dims,
      nextDims: proposal.nextDims,
    },
  });
  st.pending = null;
  st.cooldownUntilTurn = st.evidence.turns + PROPOSAL_COOLDOWN_TURNS;
  st.updatedAt = at;
  save(st);
  return {
    ok: true,
    rejected: true,
    generation: st.generation,
    dims: { ...st.dims },
    proposal,
    cooldownUntilTurn: st.cooldownUntilTurn,
    state: clone(st),
  };
}

/**
 * 人批准回滚到上一代：generations 弹栈，generation/dims 与归档一致；同样要 human-confirm。
 */
export function rollback({ approvedBy = "", reason = "", now = Date.now() } = {}) {
  const denied = requireHuman(approvedBy, "回滚");
  if (denied) return { ...denied, rolledBack: false };
  const st = load();
  if (!st.generations.length) return { ok: false, rolledBack: false, error: "没有可回退的上一代", code: "no_previous_generation" };
  if (!str(reason)) return { ok: false, rolledBack: false, error: "请填写回退理由", code: "reason_required" };

  const at = iso(now);
  const who = String(approvedBy);
  const archived = st.generations.pop();
  st.generation = Math.max(0, Math.floor(Number(archived.gen) || 0));
  st.dims = normalizeDims(archived.dims);
  const genes = archived.genes ? { ...archived.genes } : null;
  st.baseline = { dims: { ...st.dims }, genes, at, approvedBy: who, generation: st.generation };
  st.pending = null;
  // 回滚后 dims 又回到满级，没有冷却会立刻再生成同一条提案
  st.cooldownUntilTurn = st.evidence.turns + PROPOSAL_COOLDOWN_TURNS;
  st.history.push({
    at,
    action: "rollback",
    generation: st.generation,
    by: who,
    reason: str(reason),
    restoredFrom: archived.gen,
    dims: { ...st.dims },
  });
  st.updatedAt = at;
  save(st);

  let genome = null;
  try {
    if (genomeFilePath()) genome = genomeSetGeneration(st.generation, { genes, approvedBy: who, now });
  } catch {}

  return {
    ok: true,
    rolledBack: true,
    generation: st.generation,
    dims: { ...st.dims },
    restored: archived,
    baseline: clone(st.baseline),
    genome,
    state: clone(st),
  };
}

/**
 * 一行摘要（prompt 注入与 statusText 共用；永远不带换行）。
 * 正常：成长：陪伴 0.62 / 理解 0.55 / 判断 0.48 / 承担 0.40 / 治理 0.31 · 第 1 代
 * 待批：… · 第 0 代（有换代提案待批）
 * 多代：… · 第 2 代（已归档 1 代）
 */
export function statusText(state = null) {
  try {
    const st = state && typeof state === "object" ? normalizeState(state) : load();
    const dims = DIMS.map((d) => `${DIM_LABELS[d]} ${round4(st.dims[d]).toFixed(2)}`).join(" / ");
    const archived = st.generations.length ? `（已归档 ${st.generations.length} 代）` : "";
    const pend = st.pending ? "（有换代提案待批）" : "";
    return `成长：${dims} · 第 ${st.generation} 代${archived}${pend}`.replace(/\s*\n\s*/g, " ");
  } catch { return ""; }
}

/** prompt 用：与 statusText 同一行，读不到就返回空串（不影响开轮）。 */
export function promptLine(state = null) {
  return statusText(state);
}

/** 只读状态（genome_status 工具 / GET /api/genome/growth 用）。 */
export function status({ includeSources = true } = {}) {
  const st = load();
  let measured = null, sources = null, skipped = [];
  if (includeSources) {
    const m = measure({ state: st });
    measured = m.values;
    sources = m.sources;
    skipped = m.skipped;
  }
  return {
    generation: st.generation,
    dims: { ...st.dims },
    labels: DIM_LABELS,
    pending: st.pending ? clone(st.pending) : null,
    hasPending: Boolean(st.pending),
    generations: st.generations.map((g) => ({
      gen: g.gen,
      at: g.at,
      approvedBy: g.approvedBy,
      reason: g.reason,
      dims: { ...g.dims },
      genes: g.genes ? { ...g.genes } : null,
    })),
    baseline: st.baseline ? clone(st.baseline) : null,
    evidence: { ...st.evidence, guardWindowBlocks: st.evidence.guardWindow.length },
    cooldownUntilTurn: st.cooldownUntilTurn,
    measured,
    sources,
    skipped,
    prompt: statusText(st),
    file: FILE_REL,
  };
}
