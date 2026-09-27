// evolution-api.mjs —— 进化引擎（2026-09-03）
// 融合 Hermes GEPA 思想（反思式进化：读执行轨迹理解"为什么失败"→针对性变异→约束门→人工审批）
// 与 EvoX 三层优化器（提示词/工作流/记忆）对齐；Phase 1 只做提示词层。
// 红线（Hermes 同款）：所有候选变体只进提案池，人工审批后才写回，写回前自动备份原版。
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { reviewStoragePath } from "./review-file-safety.mjs";
import { atomicWriteText } from "./atomic-io.mjs";
import { scanSessionFiles, readEntriesFromFile } from "./session-files.mjs";

let wsRoot = "";
let promptsDir = "";
let skillsDir = "";
let llmChat = null; // async ({provider,id}, messages) => {text, error}
let _getDefaultModel = null; // () => {provider, id}

export function initEvolutionApi({ root = "", prompts = "", skills = "", chat = null, getDefaultModel = null } = {}) {
  wsRoot = root;
  promptsDir = prompts;
  skillsDir = skills;
  llmChat = chat;
  _getDefaultModel = getDefaultModel;
}

function poolFile() { return path.join(wsRoot, "工程/经验库/improvements.jsonl"); }
const digestText = text => createHash('sha256').update(text).digest('hex');
function promptPath(name) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_-]{1,100}$/u.test(name)) throw new Error('模板名称无效');
  return reviewStoragePath(promptsDir, `${name}.md`);
}
function loadPool() {
  try {
    return fs.readFileSync(poolFile(), "utf8").split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function savePool(items) {
  atomicWriteText(poolFile(), items.map(i => JSON.stringify(i)).join("\n") + "\n");
}

// ── 1. 从会话历史抽“纠正/失败”轨迹样本（Hermes 的 sessiondb eval-source 思路）──
const CORRECTION_HINTS = ["不对", "错了", "不是", "重新", "换个", "别这样", "我要的是", "理解错了", "搞错", "弄错", "重做", "再来", "没让你", "谁让你", "误会", "偏了", "方向错了", "歪了", "还是不行", "又"];
export function sampleTraces(limit = 24) {
  const out = [];
  // 修复（09-03）：按文件 mtime 排序取真正最近的会话（原 slice(-8) 取的是字母序尾部目录的文件）
  const files = scanSessionFiles()
    .map(f => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)
    .slice(0, 14)
    .map(x => x.f);
  for (const f of files) {
    try {
      const entries = readEntriesFromFile(f);
      const msgs = entries.filter(e => e.type === "message" && e.message);
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.message.role !== "user") continue;
        const text = typeof m.message.content === "string" ? m.message.content
          : Array.isArray(m.message.content) ? m.message.content.filter(c => c.type === "text").map(c => c.text).join(" ") : "";
        if (!text || text.length < 4 || text.length > 500) continue;
        if (CORRECTION_HINTS.some(h => text.includes(h))) {
          // 带上它前一条 assistant 回复片段做上下文
          let prev = "";
          for (let j = i - 1; j >= 0; j--) {
            if (msgs[j].message.role === "assistant") {
              const c = msgs[j].message.content;
              prev = (typeof c === "string" ? c : Array.isArray(c) ? c.filter(x => x.type === "text").map(x => x.text).join(" ") : "");
              break;
            }
          }
          out.push({ user: text.slice(0, 400), assistantBefore: prev.slice(0, 400), ts: m.timestamp || "" });
          if (out.length >= limit) return out;
        }
      }
    } catch {}
  }
  return out;
}

// ── 2. 反思 + 生成候选变体 ──
function constraintGate(original, variant) {
  if (!variant || variant.length < 40) return "变体为空或过短";
  if (variant.length > original.length * 1.8 + 500) return "变体膨胀超过安全线（>1.8x+500字符）";
  return null;
}

export async function proposeEvolution({ name, model }) {
  let tplPath;
  try { tplPath = promptPath(name); } catch { return { error: '模板路径不安全' }; }
  let original = "";
  try { original = fs.readFileSync(tplPath, "utf8"); } catch { return { error: `模板不存在: ${name}` }; }
  if (!llmChat) return { error: "LLM 通道未注入" };

  const traces = sampleTraces();
  const traceText = traces.length
    ? traces.map((t, i) => `[样本${i + 1}]\n用户(疑似纠正): ${t.user}\n此前AI回复: ${t.assistantBefore || "(无)"}`).join("\n\n")
    : "(近期无纠正样本，仅基于模板本身优化)";

  const sys = "你是提示词进化引擎。分析提示词模板与真实执行轨迹中用户纠正/失败的样本，理解失败原因（不只是失败了，而是为什么失败），生成改进后的模板候选。保持原模板的用途与结构（语义不漂移），只修复会导致误解、遗漏、格式错误的部位。输出严格 JSON: {\"analysis\":\"失败原因分析(≤200字)\",\"variants\":[{\"label\":\"变体A\",\"rationale\":\"改进点(≤80字)\",\"content\":\"完整模板全文\"}]}，恰好 2 个变体。";
  const messages = [
    { role: "system", content: sys },
    { role: "user", content: `# 当前模板（${name}）\n${original}\n\n# 执行轨迹样本（用户纠正/失败）\n${traceText}` },
  ];

  const result = await llmChat(model, messages);
  if (!result || result.error || !result.text) return { error: result?.error || "模型未返回内容" };
  let parsed; try { parsed = JSON.parse(result.text.replace(/^```json?\s*|```$/g, "").trim()); } catch { return { error: "模型输出非 JSON", raw: result.text.slice(0, 200) }; }

  const variants = (parsed.variants || []).map(v => ({ ...v, gate: constraintGate(original, v.content || "") })).filter(v => !v.gate);
  if (!variants.length) return { error: "所有变体未通过约束门", analysis: parsed.analysis };

  // 进提案池（kind: evolution，state: open）——绝不直接改模板
  const pool = loadPool();
  const propId = `evo-${randomUUID()}`;
  const proposal = {
    id: propId, kind: "evolution", target: { type: "prompt", name },
    analysis: parsed.analysis || "",
    traces: traces.length,
    variants: variants.map(v => ({ label: v.label, rationale: v.rationale, content: v.content })),
    originalPreview: original.slice(0, 300),
    originalDigest: digestText(original),
    created: new Date().toISOString(), state: "open",
  };
  pool.push(proposal); savePool(pool);
  return { ok: true, id: propId, variants: variants.length, traces: traces.length, analysis: parsed.analysis };
}

// ── 3. 人工审批后才写回（自动备份原版）──
export function applyEvolution(id, variantIndex = 0) {
  const pool = loadPool();
  const p = pool.find(x => x.id === id && x.kind === "evolution");
  if (!p) return { error: "提案不存在" };
  if (p.state !== "open") return { error: `提案状态为 ${p.state}，不可应用` };
  const v = Number.isSafeInteger(variantIndex) && variantIndex >= 0 ? p.variants?.[variantIndex] : null;
  if (!v) return { error: "变体序号无效" };
  let tplPath;
  try { tplPath = promptPath(p.target?.name); } catch { return { error: '模板路径不安全' }; }
  let original = "";
  try { original = fs.readFileSync(tplPath, "utf8"); } catch { return { error: '原模板不可读取，未写回' }; }
  if (!p.originalDigest || p.originalDigest !== digestText(original)) return { error: '原模板已变化或历史提案无基线，请重新生成提案' };
  if (typeof v.content !== 'string' || constraintGate(original, v.content)) return { error: '变体未通过内容约束' };
  const bak = `${tplPath}.bak-${randomUUID()}`;
  try {
    fs.writeFileSync(bak, original, { encoding: 'utf8', flag: 'wx' });
    atomicWriteText(tplPath, v.content);
  } catch { return { error: '备份或写入失败，未确认应用，请核对模板和备份' }; }
  p.state = "applied"; p.appliedAt = new Date().toISOString(); p.backup = path.basename(bak);
  savePool(pool);
  return { ok: true, backup: path.basename(bak) };
}

export function listEvolution() {
  return loadPool().filter(x => x.kind === "evolution")
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice(0, 30);
}

export function dismissEvolution(id) {
  const pool = loadPool();
  const p = pool.find(x => x.id === id && x.kind === "evolution");
  if (!p) return { error: "提案不存在" };
  p.state = "dismissed"; p.dismissedAt = new Date().toISOString();
  savePool(pool);
  return { ok: true };
}

// ══ 技能自主沉淀（09-03，Hermes 闭环第一件：任务完成后 nudge）══
// 触发：定时任务执行成功后 fire-and-forget（time-engine 挂钩）+ 前端手动。
// 红线同进化：草稿只进提案池，人工确认才写技能库。
export async function nudgeSkill({ label, result, trigger = "task" }) {
  if (!llmChat) return { skip: true, reason: "LLM 未注入" };
  if (!result || result.length < 120) return { skip: true, reason: "结果太短，不值得沉淀" };
  const model = _getDefaultModel ? _getDefaultModel() : null;
  if (!model) return { skip: true, reason: "无可用模型" };
  try {
    const sys = "你是技能沉淀评估器。判断一次任务执行是否包含可复用的工作方法（而非一次性琐事）。若不值得沉淀，输出 {\"skip\":true}。若值得，输出严格 JSON: {\"skip\":false,\"name\":\"kebab-case-skill-name\",\"description\":\"技能一句话描述(≤60字)\",\"skill\":\"完整 SKILL.md 全文，含 YAML frontmatter(name/description) 和 markdown 正文，正文写可复用的步骤/规则/坑\"}";
    const messages = [
      { role: "system", content: sys },
      { role: "user", content: `# 任务\n${label}\n\n# 执行结果摘要\n${String(result).slice(0, 3000)}` },
    ];
    const r = await llmChat(model, messages);
    if (!r || r.error || !r.text) return { skip: true, reason: "模型未返回" };
    let p; try { p = JSON.parse(String(r.text).replace(/^```json?\s*|```$/g, "").trim()); } catch { return { skip: true, reason: "输出非 JSON" }; }
    if (p.skip) return { skip: true, reason: "评估为一次性任务" };
    if (!p.name || !p.skill || String(p.skill).length < 120) return { skip: true, reason: "草稿不完整" };
    const pool = loadPool();
    // 同名提案去重：09-07 与 09-14 两次复盘提出过同一个 daily-retrospective，
    // 池子里并排躺着两条 open——重复提案只会变成人眼前的噪音。
    const dup = pool.find((x) => x.kind === "skill-nudge" && x.name === p.name && x.state !== "dismissed");
    if (dup) return { skip: true, reason: `同名技能提案已存在（${dup.state}）：${p.name}` };
    const id = `nudge-${Date.now()}`;
    pool.push({ id, kind: "skill-nudge", label: label || p.name, name: p.name, description: p.description || "", skill: p.skill, trigger, resultPreview: String(result).slice(0, 300), created: new Date().toISOString(), state: "open" });
    savePool(pool);
    return { ok: true, id };
  } catch (e) { return { skip: true, reason: String(e?.message || e).slice(0, 80) };
  }
}

export function applySkillNudge(id) {
  const pool = loadPool();
  const p = pool.find(x => x.id === id && x.kind === "skill-nudge");
  if (!p) return { error: "提案不存在" };
  if (p.state !== "open") return { error: `状态 ${p.state} 不可应用` };
  if (!skillsDir) return { error: "技能目录未注入" };
  const slug = String(p.name || "").toLowerCase().replace(/[^a-z0-9-_\u4e00-\u9fff]/g, "-").replace(/-+/g, "-").slice(0, 48);
  if (!slug) return { error: "技能名无效" };
  const dir = path.join(skillsDir, slug);
  if (fs.existsSync(dir)) return { error: `技能 ${slug} 已存在，请先处理同名技能` };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), p.skill, "utf8");
  p.state = "applied"; p.appliedAt = new Date().toISOString(); p.skillPath = `skills/${slug}/SKILL.md`;
  savePool(pool);
  return { ok: true, path: p.skillPath };
}

export function dismissSkillNudge(id) {
  const pool = loadPool();
  const p = pool.find(x => x.id === id && x.kind === "skill-nudge");
  if (!p) return { error: "提案不存在" };
  p.state = "dismissed"; p.dismissedAt = new Date().toISOString();
  savePool(pool);
  return { ok: true };
}

export function listSkillNudges() {
  return loadPool().filter(x => x.kind === "skill-nudge")
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice(0, 20);
}

// ══ 记忆 nudge（09-03，情绪→记忆联动）：residue 跨阈值时自动提案记忆写入 ══
// hurt→纠正记忆 / warmth→关系记忆 / curiosity→关系记忆(方向)。模板化生成零 LLM 成本。
const MEMORY_TARGETS = {
  correction: "记忆/纠正记忆.md",
  warmth: "记忆/关系记忆.md",
  curiosity: "记忆/关系记忆.md",
};
const MEMORY_LABELS = { correction: "纠正记忆", warmth: "温暖瞬间", curiosity: "探索方向" };
export function proposeMemoryNudge(info) {
  // info: { subtype, residue, message, sessionId }
  const target = MEMORY_TARGETS[info.subtype];
  if (!target) return { error: "未知 subtype" };
  const pool = loadPool();
  // 去重：同一 subtype+同一天只提一次，防骚扰
  const today = new Date().toISOString().slice(0, 10);
  if (pool.some(x => x.kind === "memory-nudge" && x.subtype === info.subtype && String(x.created).startsWith(today))) return { skip: true, reason: "今日已提过同类" };
  const summary = String(info.message || "").replace(/\s+/g, " ").slice(0, 80);
  const draft = `- ${today} [${MEMORY_LABELS[info.subtype]}·情绪残留 ${Number(info.residue).toFixed(2)}] ${summary || "（无消息摘要）"}`;
  const id = `mem-${Date.now()}`;
  pool.push({ id, kind: "memory-nudge", subtype: info.subtype, targetFile: target,
    draft, residue: Number(info.residue).toFixed(2), messagePreview: summary,
    sessionId: info.sessionId || "", created: new Date().toISOString(), state: "open" });
  savePool(pool);
  return { ok: true, id };
}
export function listMemoryNudges() {
  return loadPool().filter(x => x.kind === "memory-nudge")
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice(0, 20);
}
export function applyMemoryNudge(id) {
  const pool = loadPool();
  const p = pool.find(x => x.id === id && x.kind === "memory-nudge");
  if (!p) return { error: "提案不存在" };
  if (p.state !== "open") return { error: `状态 ${p.state} 不可应用` };
  const fp = path.join(wsRoot, p.targetFile);
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, `# ${path.basename(p.targetFile, ".md")}\n\n`, "utf8");
    fs.appendFileSync(fp, p.draft + "\n", "utf8");
  } catch (e) { return { error: "写入失败: " + String(e?.message || e).slice(0, 80) }; }
  p.state = "applied"; p.appliedAt = new Date().toISOString();
  savePool(pool);
  return { ok: true, file: p.targetFile };
}
export function dismissMemoryNudge(id) {
  const pool = loadPool();
  const p = pool.find(x => x.id === id && x.kind === "memory-nudge");
  if (!p) return { error: "提案不存在" };
  p.state = "dismissed"; p.dismissedAt = new Date().toISOString();
  savePool(pool);
  return { ok: true };
}

// ══ 记忆进化压缩（09-03，EvoX MemoryOptimizer：compressionRatio + smartSummary）══
// 早期条目（>14 天）→ LLM 压成要点摘要 → 原文归档到 记忆/归档/ → 审批后备份+重写日志。
// 红线同前：提案制 + 自动备份；最近 14 天条目永不触碰。
const LOG_HEADING_RE = /^#{2,4}\s\d{4}-\d{2}-\d{2}/;
const FRESH_DAYS = 14, COMPRESS_MIN = 20;
function logPath() { return path.join(wsRoot, "记忆", "记忆日志.md"); }
function splitLogBlocks(raw) {
  const lines = raw.split("\n"); const blocks = []; let cur = [];
  for (const ln of lines) {
    if (LOG_HEADING_RE.test(ln)) { if (cur.length) blocks.push(cur.join("\n")); cur = [ln]; }
    else if (cur.length) cur.push(ln);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks.filter(b => b.trim());
}
export function analyzeMemoryCompress() {
  try {
    const fp = logPath();
    if (!fs.existsSync(fp)) return { total: 0, fresh: 0, old: 0 };
    const blocks = splitLogBlocks(fs.readFileSync(fp, "utf8"));
    const cutoff = Date.now() - FRESH_DAYS * 86400000;
    let fresh = 0, old = 0, oldest = "";
    for (const b of blocks) {
      const d = b.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
      if (d && new Date(d).getTime() < cutoff) { old++; if (!oldest || d < oldest) oldest = d; }
      else fresh++;
    }
    return { total: blocks.length, fresh, old, oldest, worthIt: old >= COMPRESS_MIN };
  } catch (e) { return { error: String(e?.message || e).slice(0, 100) }; }
}
export async function proposeMemoryCompress(model) {
  if (!llmChat || !model) return { error: "LLM 未注入" };
  const a = analyzeMemoryCompress();
  if (a.error) return a;
  if (!a.worthIt) return { error: `早期条目仅 ${a.old} 条（需 ≥${COMPRESS_MIN}），暂不值得压缩` };
  const fp = logPath();
  const blocks = splitLogBlocks(fs.readFileSync(fp, "utf8"));
  const cutoff = Date.now() - FRESH_DAYS * 86400000;
  const oldBlocks = blocks.filter(b => { const d = b.match(/(\d{4}-\d{2}-\d{2})/)?.[1]; return d && new Date(d).getTime() < cutoff; });
  // smartSummary：压缩到 ≤30 行要点，保留可复用结论/踩坑/约定，丢弃过程性流水账
  const input = oldBlocks.map(b => b.replace(/\s+/g, " ").slice(0, 300)).join("\n").slice(0, 24000);
  const r = await llmChat(model, [
    { role: "system", content: "你是记忆压缩器。把一段时间的工作日志压缩成要点摘要：保留仍然有效的可复用结论、踩坑教训、约定和资产路径；丢弃过程性叙述和已完成的临时事项。输出 markdown 列表，≤30 行，每行一条，不写开头结尾客套。" },
    { role: "user", content: `# 待压缩的历史日志（共 ${oldBlocks.length} 条）\n${input}` },
  ]);
  if (!r || r.error || !r.text) return { error: "摘要生成失败: " + (r?.error || "空响应").slice(0, 80) };
  const summaryText = String(r.text).trim();
  if (summaryText.length < 50) return { error: "摘要过短，疑似异常" };
  const pool = loadPool();
  const id = `mcp-${Date.now()}`;
  pool.push({ id, kind: "memory-compress", file: "记忆/记忆日志.md",
    beforeCount: a.total, archiveCount: oldBlocks.length, keptCount: a.fresh,
    summaryText, oldRange: `${a.oldest} ~`, created: new Date().toISOString(), state: "open" });
  savePool(pool);
  return { ok: true, id, beforeCount: a.total, archiveCount: oldBlocks.length };
}
export function listMemoryCompress() {
  return loadPool().filter(x => x.kind === "memory-compress")
    .sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, 5);
}
export function applyMemoryCompress(id) {
  const pool = loadPool();
  const p = pool.find(x => x.id === id && x.kind === "memory-compress");
  if (!p) return { error: "提案不存在" };
  if (p.state !== "open") return { error: `状态 ${p.state} 不可应用` };
  const fp = logPath();
  if (!fs.existsSync(fp)) return { error: "日志文件不存在" };
  const raw = fs.readFileSync(fp, "utf8");
  const blocks = splitLogBlocks(raw);
  const cutoff = Date.now() - FRESH_DAYS * 86400000;
  const freshBlocks = blocks.filter(b => { const d = b.match(/(\d{4}-\d{2}-\d{2})/)?.[1]; return !d || new Date(d).getTime() >= cutoff; });
  const oldBlocks = blocks.filter(b => { const d = b.match(/(\d{4}-\d{2}-\d{2})/)?.[1]; return d && new Date(d).getTime() < cutoff; });
  if (!oldBlocks.length) return { error: "已无早期条目（可能已被压缩过）" };
  // 备份 → 原子重写（摘要节置顶 + 保留近期块）→ 归档原文
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const backup = fp + ".bak-" + stamp;
  fs.writeFileSync(backup, raw, "utf8");
  const keepHead = raw.slice(0, raw.search(LOG_HEADING_RE) > 0 ? raw.search(LOG_HEADING_RE) : 0);
  const summarySection = `## 历史要点摘要（${p.oldRange || ""}压缩于 ${stamp.slice(0, 10)}）\n\n${p.summaryText}\n\n`;
  const newRaw = keepHead + summarySection + freshBlocks.join("\n\n") + "\n";
  fs.writeFileSync(fp, newRaw, "utf8");
  const archiveDir = path.join(wsRoot, "记忆", "归档");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archiveFile = path.join(archiveDir, `记忆日志-${stamp.slice(0, 10)}.md`);
  fs.writeFileSync(archiveFile, `# 记忆日志归档 ${p.oldRange || ""}\n\n` + oldBlocks.join("\n\n") + "\n", "utf8");
  p.state = "applied"; p.appliedAt = new Date().toISOString(); p.backup = backup; p.archiveFile = archiveFile;
  savePool(pool);
  return { ok: true, backup, archiveFile };
}
export function dismissMemoryCompress(id) {
  const pool = loadPool();
  const p = pool.find(x => x.id === id && x.kind === "memory-compress");
  if (!p) return { error: "提案不存在" };
  p.state = "dismissed"; p.dismissedAt = new Date().toISOString();
  savePool(pool);
  return { ok: true };
}

// ══ 进化评测基准（09-03，EvoX benchmark + Hermes eval：让变体选择有数据支撑）══
// 流程：LLM 基于模板用途出 4 道典型题 → 原版/每个变体各作答 → LLM judge 评分(0-100) → 均值写回提案。
async function _chat(model, sys, user) {
  const timeout = new Promise(resolve => setTimeout(() => resolve(""), 150_000)); // 单次超时 150s，防单点挂死卡死整个评测
  const call = llmChat(model, [{ role: "system", content: sys }, { role: "user", content: user }]);
  const r = await Promise.race([call, timeout]);
  return r && !r.error ? String(r.text || "") : "";
}
export async function evaluateProposal(id, model) {
  const pool = loadPool();
  const p = pool.find(x => x.id === id && x.kind === "evolution");
  if (!p) return { error: "提案不存在" };
  if (!llmChat || !model) return { error: "LLM 未注入" };
  let tplPath;
  try { tplPath = promptPath(p.target?.name); } catch { return { error: '模板路径不安全' }; }
  let original = "";
  try { original = fs.readFileSync(tplPath, "utf8"); } catch { return { error: "原模板已不存在" }; }

  // 1. 出题（4 道典型使用场景）
  const quizRaw = await _chat(model, "你是评测出题器。基于提示词模板的用途，出 4 道该模板应该能处理好的典型任务题，每题带场景差异（常规/边界/信息不足/干扰信息）。输出严格 JSON: {\"questions\":[\"题1\",\"题2\",\"题3\",\"题4\"]}", `# 模板用途\n${original.slice(0, 1200)}`);
  let questions = [];
  try { questions = JSON.parse(quizRaw.replace(/^```json?\s*|```$/g, "").trim()).questions || []; } catch {}
  if (!questions.length) return { error: "出题失败" };

  // 2. 各版本作答 + 3. judge 评分
  const judgeSys = "你是严格评委。给定提示词模板产出的回答，从 0-100 打分：意图理解 30 分、回答完整性 30 分、格式与可用性 20 分、不废话不跑题 20 分。只输出数字。";
  const scoreOf = async (tpl, q) => {
    const answer = await _chat(model, tpl.slice(0, 6000), q);
    if (!answer) return 0;
    const s = await _chat(model, judgeSys, `# 题目\n${q}\n\n# 回答\n${answer.slice(0, 2000)}`);
    const n = parseInt(String(s).replace(/[^0-9]/g, ""), 10);
    return isNaN(n) ? 0 : Math.min(100, n);
  };
  const run = async (tpl) => {
    const scores = [];
    for (const q of questions) scores.push(await scoreOf(tpl, q));
    return scores;
  };
  const origScores = await run(original);
  const variantScores = [];
  for (const v of p.variants) variantScores.push(await run(v.content));

  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  p.evaluation = {
    questions, at: new Date().toISOString(),
    original: { scores: origScores, avg: avg(origScores) },
    variants: p.variants.map((v, i) => ({ label: v.label, scores: variantScores[i] || [], avg: avg(variantScores[i] || []) })),
    best: null,
  };
  const all = [{ label: "原版", avg: p.evaluation.original.avg }, ...p.evaluation.variants.map(v => ({ label: v.label, avg: v.avg }))];
  p.evaluation.best = all.sort((a, b) => b.avg - a.avg)[0]?.label || null;
  savePool(pool);
  return { ok: true, evaluation: p.evaluation };
}
