// ===== aibody-soil.mjs —— AIBody 的「土壤」：五个状态提供者的真实读数 =====
//
// AIBody 把 identity / genes / emotion / memory / governance 当作 agent 站的地。
// 但之前这五项里有三项是**写死的字符串**：
//   identity   → "元枢主角色：小语"
//   governance → "高风险操作与人格提案保持人工确认"
//   genes      → "11 基因人格基线与表达已加载"（只有 count 是真的）
//   memory     → 只证明 记忆.md 存在
// 这些 summary 每轮都会被拼进 directive 交给模型，于是模型被告知"固定记忆已接入"
// ——不管是否属实。这和整个项目在治的是同一种病：**没被观测的说法**。
//
// 这里的规矩：**每一项都要能被真实读到；读不到就返回 null**，
// 由 aibody-runtime-policy 标记为 not_observed（而不是编一句好听的话）。
import fs from "node:fs";
import path from "node:path";

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtTime(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return "";
  const p = n => String(n).padStart(2, "0");
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** 每项独立兜底：一项抛异常不能让整块土壤变成 unavailable（policy 是整体 try/catch 的）。 */
function safe(read) {
  try { return read() || null; } catch { return null; }
}

export function createSoilReader({ agentDir = "", cwd = "", emotion = null, fsMod = fs, now = () => new Date() } = {}) {
  const statOf = p => { try { return fsMod.statSync(p); } catch { return null; } };

  // ① 身份：人格/系统附录文件真实存在且可读，而不是"元枢主角色：小语"这句常量
  function readIdentity() {
    const candidates = [
      path.join(agentDir, "APPEND_SYSTEM.md"),
      path.join(agentDir, "元枢.md"),
    ];
    const hit = candidates.map(p => ({ p, st: statOf(p) })).find(x => x.st && x.st.isFile());
    if (!hit) return null;
    fsMod.readFileSync(hit.p, 'utf8');
    return {
      summary: `人格附录 ${path.basename(hit.p)} 文件可读（${fmtBytes(hit.st.size)}，${fmtTime(hit.st.mtime)} 更新）；本轮加载情况未核实`,
      details: { file: path.basename(hit.p), bytes: hit.st.size, updatedAt: new Date(hit.st.mtime).toISOString() },
    };
  }

  // ② 基因：条数 + **真实漂移**（expression 偏离 baseline 的基因），不是"已加载"这种空话
  function readGenes() {
    const genome = emotion?.getGenome?.();
    const genes = genome?.genes;
    if (!genes || typeof genes !== "object" || Array.isArray(genes)) return null;
    const names = Object.keys(genes);
    if (!names.length) return null;
    if (names.some(n => !Number.isFinite(genes[n]?.expression) || !Number.isFinite(genes[n]?.baseline))) return null;
    const drifted = names.filter(n => {
      const g = genes[n] || {};
      const e = Number(g.expression), b = Number(g.baseline);
      return Number.isFinite(e) && Number.isFinite(b) && Math.abs(e - b) >= 0.1;
    });
    const summary = drifted.length
      ? `${names.length} 个基因，其中 ${drifted.length} 个偏离基线 ≥0.1（${drifted.slice(0, 3).join("、")}${drifted.length > 3 ? "…" : ""}）`
      : `${names.length} 个基因，均贴近基线`;
    return { summary, details: { count: names.length, drifted: drifted.slice(0, 8), snapshots: (genome.snapshots || []).length } };
  }

  // ③ 情绪：**本会话**的快照。没聊过就不算观测到——不再拿别的会话的凑数。
  function readEmotion(context) {
    const key = String(context?.sessionId || "").trim();
    if (!key) return null;
    const st = emotion?.getSnapshot?.(key);
    // getSnapshot 对未知会话会造一个默认态返回，所以"有没有真观测到"要看 lastTalk
    if (!st || !st.lastTalk) return null;
    const label = st.primary || "未知";
    const intensity = Number.isFinite(Number(st.intensity)) ? Number(st.intensity) : null;
    return {
      summary: `最近会话记录（${fmtTime(st.lastTalk)}）：${label}${intensity != null ? ` · 强度 ${intensity}` : ""}${st.secondary ? ` · 次 ${st.secondary}` : ""}`,
      details: { sessionId: key, primary: label, secondary: st.secondary || null, intensity, lastTalk: new Date(st.lastTalk).toISOString() },
    };
  }

  // ④ 记忆：真实大小 + 最后写入时间 + 条目数，而不是"文件存在"这一条
  function readMemory() {
    const f = path.join(cwd || "", "记忆.md");
    const st = statOf(f);
    if (!st || !st.isFile()) return null;
    const text = fsMod.readFileSync(f, "utf8");
    const sections = (text.match(/^#{1,3}\s+/gm) || []).length;
    return {
      summary: `固定记忆 ${fmtBytes(st.size)} · ${sections} 个标题 · ${fmtTime(st.mtime)} 更新（文件读数，不代表本轮已引用）`,
      details: { bytes: st.size, sections, updatedAt: new Date(st.mtime).toISOString() },
    };
  }

  // ⑤ 治理：**待人工确认的提案条数**，而不是"保持人工确认"这句常量
  function readGovernance() {
    const genome = emotion?.getGenome?.();
    if (!genome || !Array.isArray(genome.proposals) || !Array.isArray(genome.reviews)) return null;
    const proposals = Array.isArray(genome.proposals) ? genome.proposals : [];
    const pending = proposals.filter(p => p && p.status === "pending");
    const reviews = Array.isArray(genome.reviews) ? genome.reviews : [];
    return {
      summary: pending.length
        ? `有 ${pending.length} 条人格/基因提案待人工确认（不自动批准），已审 ${reviews.length} 条`
        : `人格/基因无待批提案，已审 ${reviews.length} 条；不包含工具等其他审批队列`,
      details: { pending: pending.length, reviewed: reviews.length, geneNames: pending.map(p => p.gene).filter(Boolean).slice(0, 8) },
    };
  }

  return function readSoil(context = {}) {
    return {
      identity: safe(readIdentity),
      genes: safe(readGenes),
      emotion: safe(() => readEmotion(context)),
      memory: safe(readMemory),
      governance: safe(readGovernance),
    };
  };
}
