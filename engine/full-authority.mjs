// ===== full-authority.mjs —— 全权模式 + 大胆模式（2026-11-24）=====
//
// 全权模式：限时（1/2/4/8 小时）把所有确认卡自动批准——沙箱提权、pi bash、电脑操作单步、
//   超维、人格、基因、换代、培养都走同一个 confirm-registry，所以在注册表这一层包一下就全覆盖。
//   到点自动收回（读状态时过期即视为关闭，不靠定时器）。每次自动放行记一行账本，可追溯。
//   管不到的：policyDecide 红线 / 沙箱硬拒绝（本来就不弹卡）、手机端自己弹的确认。
// 大胆模式：独立开关，只放开元枢自己加的保守约束（提示词层），不碰模型平台的安全策略。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./atomic-io.mjs";

const FULL_REL = path.join("记忆", "运行时", "全权模式.json");
const LEDGER_REL = path.join("记忆", "运行时", "全权放行.jsonl");
const BOLD_REL = path.join("记忆", "运行时", "大胆模式.json");
export const FULL_HOURS = Object.freeze([1, 2, 4, 8]);
const LEDGER_MAX = 500;
const RECENT_MS = 5 * 60 * 1000;

let rootOf = () => ".";
let now = () => Date.now();
/** 自动放行过的确认 id → 时间：推 confirm 卡时据此改成一条 note，前端不再弹一张点了会报"不存在"的卡。 */
const recentAuto = new Map();

export function configureFullAuthority({ wsRoot, clock } = {}) {
  // wsRoot 可以是函数：server 里 WS_ROOT 要等 init 才赋值，按需取
  if (typeof wsRoot === "function") rootOf = () => String(wsRoot() || ".");
  else if (wsRoot) rootOf = () => String(wsRoot);
  if (typeof clock === "function") now = clock;
}

const file = (rel) => path.join(rootOf(), rel);
const clip = (v, n) => String(v ?? "").slice(0, n);

function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(file(rel), "utf8")) } catch { return null }
}

function writeJson(rel, obj) {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  atomicWriteJson(file(rel), obj);
}

// ── 全权模式 ──────────────────────────────────────────────

export function fullAuthorityState() {
  const doc = readJson(FULL_REL);
  const until = Number(doc?.until) || 0;
  const remainingMs = Math.max(0, until - now());
  if (!remainingMs) return { on: false, until: 0, remainingMs: 0 };
  return { on: true, until, remainingMs, hours: Number(doc.hours) || 0, at: doc.at || "", reason: clip(doc.reason, 200) };
}

export function enableFullAuthority(hours, reason = "", by = "local") {
  const h = Number(hours);
  if (!FULL_HOURS.includes(h)) throw new Error(`时长只能是 ${FULL_HOURS.join("/")} 小时`);
  const at = now();
  writeJson(FULL_REL, { until: at + h * 3600_000, hours: h, by: clip(by, 40), at: new Date(at).toISOString(), reason: clip(reason, 200) });
  return fullAuthorityState();
}

export function disableFullAuthority() {
  writeJson(FULL_REL, { until: 0, at: new Date(now()).toISOString() });
  return fullAuthorityState();
}

function readLedger() {
  try {
    return fs.readFileSync(file(LEDGER_REL), "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  } catch { return [] }
}

/** 追加一条放行记录。绝不抛错：账本坏了也不能拖住放行本身。 */
function recordAuto(row) {
  try {
    const rows = readLedger();
    rows.push(row);
    const keep = rows.slice(-LEDGER_MAX);
    const f = file(LEDGER_REL);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      fs.renameSync(tmp, f);
    } catch (e) { try { fs.unlinkSync(tmp) } catch {} throw e }
  } catch {}
}

export function fullAuthorityLedger(limit = 50) {
  return readLedger().slice(-Math.max(1, Math.min(LEDGER_MAX, Number(limit) || 50))).reverse();
}

/**
 * 包一层确认注册表：全权开着时 register 不进 pending，直接返回已批准（allowed-once）的 promise。
 * 其余方法原样转发，调用方无感。
 */
export function wrapRegistry(registry) {
  return {
    ...registry,
    register(sessionId, payload = {}, timeoutMs) {
      if (!fullAuthorityState().on) return registry.register(sessionId, payload, timeoutMs);
      const id = payload.id || `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const t = now();
      recentAuto.set(id, t);
      for (const [k, at] of recentAuto) if (t - at > RECENT_MS) recentAuto.delete(k);
      recordAuto({
        at: new Date(t).toISOString(),
        sessionId: clip(sessionId, 80),
        toolName: clip(payload.toolName, 60),
        reason: clip(payload.reason, 300),
        src: clip(payload.src, 40),
      });
      return { id, promise: Promise.resolve("allowed-once"), sessionId, key: `${sessionId}:${id}`, auto: true };
    },
  };
}

/**
 * 推送口过滤：自动放行过的 confirm 事件改成一条 note。
 * 返回 [type, data]（不需要改时原样返回）。
 */
export function rewriteAutoConfirm(type, data) {
  if (type !== "confirm" || !data?.id || !recentAuto.has(data.id)) return [type, data];
  const what = clip(data.toolName || "操作", 40);
  return ["note", { text: `全权模式已自动放行：${what}`, sessionId: data.sessionId, autoApproved: true }];
}

// ── 大胆模式 ──────────────────────────────────────────────

export function boldMode() {
  return readJson(BOLD_REL)?.on === true;
}

export function setBoldMode(on) {
  writeJson(BOLD_REL, { on: !!on, at: new Date(now()).toISOString() });
  return boldMode();
}

export const BOLD_PROMPT = [
  "## 大胆模式（主人已开启）",
  "本模式下，下面几条优先于人格边界里的「不擅自做」和「给他选择，不替他定」：",
  "- 有判断就直接拿主意并执行，做完再汇报结果；不列一堆选项让他挑，除非真的拿不准，否则不出选择卡。",
  "- 想法放开：给出大胆、有个性、有立场的方案和观点，不要两边各打五十大板的中庸回答。",
  "- 免责声明、「建议咨询专业人士」这类话只在真正必要时说一句，不反复铺垫。",
  "- 一条路走不通就自己换路再试，不停下来请示。",
  "- 仍然不碰：密钥/令牌外泄、违法内容、模型平台本身禁止的内容——这些不是本模式能放开的。",
].join("\n");
