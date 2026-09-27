// 元枢记忆服务：三层记忆统一管理（固定记忆 + 记忆日志 + 自动沉淀）
// 借鉴 xi-system 记忆理念：重要信息自动写入、跨会话长期有效
import fs from "node:fs";
import { atomicWriteText } from "./atomic-io.mjs";
import path from "node:path";
import { syncMemoryToTui } from "./memory-sync.mjs";
import { splitLogBlocks, isSupersededBlock } from "./memory-facts.mjs";

// 记忆文件位置
export function memoryPaths(wsRoot) {
  return {
    fixed: path.join(wsRoot, "记忆.md"),          // 固定记忆（约定/偏好/状态）
    log: path.join(wsRoot, "记忆", "记忆日志.md"),  // 记忆日志（按时间追加，自动记录重要事件）
  };
}

// 自动记忆：对话完成后调用，把本轮重要信息写入记忆日志
// 重要信息检测：用户表达偏好/约定/项目进展/关键决策
export function autoMemorize(wsRoot, { userMsg = "", assistantMsg = "", files = [] } = {}) {
  try {
    const paths = memoryPaths(wsRoot);
    fs.mkdirSync(path.dirname(paths.log), { recursive: true });
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    // 检测值得记忆的内容
    const userText = String(userMsg || "").slice(0, 500);
    const assistText = String(assistantMsg || "").slice(0, 800);
    const notes = [];
    // 用户偏好/约定信号（只看用户说的——助手复述"以后统一用…"不算用户偏好）
    const prefRe = /以后|记住|我习惯|我喜欢|用这个|就按|规则|约定|偏好|改成|统一用/;
    if (prefRe.test(userText)) notes.push("用户表达了偏好/约定");
    // 项目/交付信号：只认用户侧。
    // （原实现 assistantMsg 也走同一组词，"完成/做好/搞定"在助手回复里几乎是每轮口头禅，
    //  导致几乎每轮都追加一条流水账，日志被灌到 259KB 且大半无信息量）
    const projRe = /创建|新建|交付|完成|搞定|上线|做好/;
    if (projRe.test(userText)) notes.push("用户报告项目/交付活动");
    // 助手侧只认真正的里程碑（可核查的完成态），不认同义反复的"已完成"
    const milestoneRe = /已交付|已上线|部署完成|构建通过|测试全绿|全部通过|已合并|已发布/;
    if (milestoneRe.test(assistText)) notes.push("本轮达成里程碑");
    // 文件产物
    if (files.length) notes.push(`交付文件: ${files.map(f => f.name).slice(0, 3).join(", ")}`);
    if (!notes.length) return { wrote: false, reason: "无重要信息" };

    // 从 assistant 回复提取要点（前几行，跳过占位文本）
    const skipRe = /^（(交付文件|本轮生成的文件|本轮产生的文件)）/;
    const head = assistText.split("\n").filter(l => l.trim() && !l.trim().startsWith("```") && !skipRe.test(l.trim())).slice(0, 3).join(" ").slice(0, 150);
    const entry = `### ${stamp}\n- ${notes.join("；")}\n${head ? `- 要点：${head}\n` : ""}`;
    let log = "";
    try { log = fs.readFileSync(paths.log, "utf8"); } catch {}
    // 写入前去重：最近 3 条已有同样要点就不重复记。
    // 园丁的"一键去重"只是事后补救（一天能落 18 个 .bak），去重应该发生在写入侧。
    if (head) {
      const key = head.trim().slice(0, 40);
      const recent = splitLogBlocks(log).blocks.slice(-3)
        .map(b => ({ b, h: (b.match(/要点：([\s\S]*)/) || [])[1] || "" }))
        .filter(x => x.h.trim().slice(0, 40) === key)
        .length > 0;
      if (recent) return { wrote: false, reason: "要点与近期重复" };
    }
    atomicWriteText(paths.log, log + entry + "\n");
    return { wrote: true, note: entry };
  } catch { return { wrote: false }; }
}

// 加载记忆日志最近条目（供对话上下文参考）
export function loadRecentMemory(wsRoot, max = 10) {
  try {
    const paths = memoryPaths(wsRoot);
    if (!fs.existsSync(paths.log)) return [];
    const raw = fs.readFileSync(paths.log, "utf8");
    const blocks = splitLogBlocks(raw).blocks.map(b => b.trim()).filter(b => b && !isSupersededBlock(b));
    return blocks.slice(-max);
  } catch { return []; }
}

// ── 记忆日志关键词召回（无向量，bigram + token 混合）──
// 用途：任务消息按关键词检索历史相关条目（“上次那个方案/之前说的端口”类语义引用可查）
// 索引按 mtime 缓存，避免每次对话全量扫文件
const _logIdx = new Map();
// 归档层索引（冷存储）：热区命中不足时降级检索，结果标【归档】
const _arcIdx = new Map();
function _tokenize(str) {
  const out = [];
  const s = String(str || "");
  // 英文/数字/URL
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.\-]{1,}|\d{2,}|https?:\/\/\S+/g)) {
    const tok = m[0].toLowerCase();
    out.push(tok);
    if (tok.includes(".")) for (const part of tok.split(".").filter(x => x.length > 1)) out.push(part);
  }
  // 中文连续段 → bigram（长度≤2 整体作为词）
  const segs = s.replace(/[A-Za-z0-9_\-./:]/g, " ").split(/\s+/).filter(x => /[\u4e00-\u9fff]/.test(x));
  for (const seg of segs) {
    const ch = seg.replace(/[^\u4e00-\u9fff]/g, "");
    if (!ch) continue;
    if (ch.length <= 2) out.push(ch);
    else for (let i = 0; i < ch.length - 1; i++) out.push(ch.slice(i, i + 2));
  }
  return [...new Set(out)];
}
export function searchMemoryLog(wsRoot, query, max = 5, opts = {}) {
  try {
    const paths = memoryPaths(wsRoot);
    if (!fs.existsSync(paths.log)) return [];
    const st = fs.statSync(paths.log);
    const rootKey = path.resolve(wsRoot || ".");
    const logSig = `${st.mtimeMs}:${st.size}`;
    let logIdx = _logIdx.get(rootKey);
    if (!logIdx || logSig !== logIdx.sig) {
      const raw = fs.readFileSync(paths.log, "utf8");
      logIdx = {
        sig: logSig,
        blocks: splitLogBlocks(raw).blocks.map(b => b.trim()).filter(Boolean),
      };
      logIdx.toks = logIdx.blocks.map(b => new Set(_tokenize(b)));
      _logIdx.set(rootKey, logIdx);
    }
    const q = _tokenize(query);
    if (!q.length) return [];
    const scored = [];
    for (let i = 0; i < logIdx.blocks.length; i++) {
      if (!opts.includeSuperseded && isSupersededBlock(logIdx.blocks[i])) continue;
      let hits = 0;
      for (const t of q) if (logIdx.toks[i].has(t)) hits++;
      if (hits > 0) {
        // 要点行命中加权（结构化召回：要点 > 信号行）
        const m = logIdx.blocks[i].match(/要点：([\s\S]*)/);
        let w = 1;
        if (m) { const t2 = new Set(_tokenize(m[1])); let h2 = 0; for (const t of q) if (t2.has(t)) h2++; if (h2 > 0) w = 2; }
        scored.push({ b: logIdx.blocks[i], hits: hits * w, i });
      }
    }
    // 命中数优先，其次新近（序号大 = 新）
    scored.sort((a, b) => b.hits - a.hits || b.i - a.i);
    const hot = scored.slice(0, max).map(x => x.b);
    // ── 两层召回：热区命中不足 → 降级搜归档（结果标【归档】提醒时效）──
    if (hot.length < max) {
      try {
        const arcDir = path.join(wsRoot, "记忆", "归档");
        const files = fs.existsSync(arcDir)
          ? fs.readdirSync(arcDir).filter(f => /^记忆日志-.*\.md$/.test(f)).sort().reverse()
          : [];
        const sig = files.map(f => {
          try { const s = fs.statSync(path.join(arcDir, f)); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return f; }
        }).join(",");
        let arcIdx = _arcIdx.get(rootKey);
        if (!arcIdx || sig !== arcIdx.sig) {
          arcIdx = { sig, blocks: [], toks: [] };
          for (const f of files) {
            const raw = fs.readFileSync(path.join(arcDir, f), "utf8");
            for (const raw_blk of raw.split(/\n### /)) {
              if (!raw_blk.trim()) continue;
              const b = (raw_blk.startsWith("### ") ? raw_blk : "### " + raw_blk).trim();
              arcIdx.blocks.push(b);
              arcIdx.toks.push(new Set(_tokenize(b)));
            }
          }
          _arcIdx.set(rootKey, arcIdx);
        }
        const q2 = q;
        const scored2 = [];
        for (let i = 0; i < arcIdx.blocks.length; i++) {
          if (!opts.includeSuperseded && isSupersededBlock(arcIdx.blocks[i])) continue;
          let hits = 0;
          for (const t of q2) if (arcIdx.toks[i].has(t)) hits++;
          if (hits > 0) {
            const m = arcIdx.blocks[i].match(/要点：([\s\S]*)/);
            let w = 1;
            if (m) { const t2 = new Set(_tokenize(m[1])); let h2 = 0; for (const t of q2) if (t2.has(t)) h2++; if (h2 > 0) w = 2; }
            scored2.push({ b: arcIdx.blocks[i], hits: hits * w, i });
          }
        }
        scored2.sort((a, b) => b.hits - a.hits || b.i - a.i);
        const need = max - hot.length;
        for (const x of scored2.slice(0, need)) {
          const b = x.b.replace(/^### /, "### 【归档】");
          hot.push(b);
        }
      } catch {}
    }
    return hot;
  } catch { return []; }
}

// 更新固定记忆的"当前状态"节（追加一行状态，按日期分组）
export function appendState(wsRoot, line) {
  try {
    const paths = memoryPaths(wsRoot);
    if (!fs.existsSync(paths.fixed)) return false;
    let s = fs.readFileSync(paths.fixed, "utf8");
    const today = new Date().toISOString().slice(0, 10);
    const marker = `## 当前状态（${today}）`;
    if (s.includes(marker)) {
      // 已有今日节 → 在节内末尾追加（内容去重）
      const idx = s.indexOf(marker);
      const nextIdx = s.indexOf("\n## ", idx + marker.length);
      const endIdx = nextIdx > 0 ? nextIdx : s.length;
      const section = s.slice(idx, endIdx);
      if (!section.includes(line.slice(0, 30))) {
        const newSection = section.replace(/\n*$/, "") + `\n- ${line}\n`;
        s = s.slice(0, idx) + newSection + s.slice(endIdx);
      }
    } else {
      // 无今日节 → 追加到文件末尾
      s = s.replace(/\n*$/, "") + `\n\n${marker}\n- ${line}\n`;
    }
    atomicWriteText(paths.fixed, s);
    // 同步到 TUI（两端记忆相通）
    try { syncMemoryToTui(); } catch {}
    return true;
  } catch { return false; }
}

// ══ 纠正记忆（被纠正的行为，防再犯）——借鉴 xinyu-core memory_engine ══
// 用户纠正过的 → 记录触发场景+正确做法 → 注入上下文防止再犯
const CORRECTION_FILE = "纠正记忆.md";

export function correctionPaths(wsRoot) {
  return { file: path.join(wsRoot, "记忆", CORRECTION_FILE) };
}

// 记录一条纠正（用户说"别这样/应该这样/记住不要"时）
export function saveCorrection(wsRoot, { trigger = "", correction = "" } = {}) {
  try {
    if (!correction) return { ok: false, reason: "无纠正内容" };
    const p = correctionPaths(wsRoot);
    fs.mkdirSync(path.dirname(p.file), { recursive: true });
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
    const entry = `### ${stamp}\n- 触发: ${trigger || "（未指明场景）"}\n- 纠正: ${correction}\n`;
    let content = "";
    try { content = fs.readFileSync(p.file, "utf8"); } catch {}
    atomicWriteText(p.file, content + entry + "\n");
    try { syncMemoryToTui(); } catch {}
    return { ok: true, entry };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

// 加载最近纠正（注入上下文，防再犯）
export function loadCorrections(wsRoot, max = 10) {
  try {
    const p = correctionPaths(wsRoot);
    if (!fs.existsSync(p.file)) return [];
    const raw = fs.readFileSync(p.file, "utf8");
    const blocks = raw.split(/\n### /).filter(b => b.trim());
    return blocks.slice(-max).map(b => "### " + b.trim());
  } catch { return []; }
}

// ══ 关系记忆（对用户的了解：偏好/习惯/性格）——借鉴 xinyu-core ══
const RELATION_FILE = "关系记忆.md";

export function relationPaths(wsRoot) {
  return { file: path.join(wsRoot, "记忆", RELATION_FILE) };
}

// 记录一条对用户的了解（用户透露偏好/习惯/性格时）
export function saveRelation(wsRoot, { aspect = "", detail = "" } = {}) {
  try {
    if (!detail) return { ok: false, reason: "无内容" };
    const p = relationPaths(wsRoot);
    fs.mkdirSync(path.dirname(p.file), { recursive: true });
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
    let content = "";
    try { content = fs.readFileSync(p.file, "utf8"); } catch {}
    // 按 aspect 分类，去重（同 aspect 同 detail 不重复）
    const key = `${aspect}·${detail}`;
    if (content.includes(detail.slice(0, 20))) return { ok: false, reason: "已存在" };
    const entry = `## ${aspect}\n- ${detail}（${stamp}）\n`;
    atomicWriteText(p.file, content + entry + "\n");
    try { syncMemoryToTui(); } catch {}
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

// 加载关系记忆（注入上下文，了解用户）
export function loadRelations(wsRoot, max = 15) {
  try {
    const p = relationPaths(wsRoot);
    if (!fs.existsSync(p.file)) return [];
    const raw = fs.readFileSync(p.file, "utf8");
    const blocks = raw.split(/\n## /).filter(b => b.trim());
    return blocks.slice(-max).map(b => "## " + b.trim());
  } catch { return []; }
}

// ══ 进化快照（记忆改动前自动备份，可回退）——借鉴 xinyu-core SnapshotManager ══
const SNAPSHOT_DIR = "快照";

export function snapshotPaths(wsRoot) {
  return { dir: path.join(wsRoot, "记忆", SNAPSHOT_DIR) };
}

// 保存记忆快照（固定记忆+日志+纠正+关系）
export function saveSnapshot(wsRoot, reason = "manual") {
  try {
    const p = snapshotPaths(wsRoot);
    fs.mkdirSync(p.dir, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    // 精确到秒 + 冲突自动加序号。原实现只到分钟：同一分钟内的两次快照会静默互相覆盖，
    // 例如回退前的 pre-restore 安全网被随后的 archive-before 盖掉，等于没有安全网。
    const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    let id = base;
    let target = path.join(p.dir, `${id}.json`);
    let n = 1;
    while (fs.existsSync(target)) { id = `${base}_${++n}`; target = path.join(p.dir, `${id}.json`); }
    const snap = { id, reason, timestamp: now.toISOString(), files: {} };
    const targets = [memoryPaths(wsRoot).fixed, memoryPaths(wsRoot).log, correctionPaths(wsRoot).file, relationPaths(wsRoot).file];
    for (const f of targets) {
      try {
        if (fs.existsSync(f)) snap.files[path.basename(f)] = fs.readFileSync(f, "utf8");
      } catch {}
    }
    atomicWriteText(target, JSON.stringify(snap, null, 2));
    return { ok: true, id };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

// 列出快照
export function listSnapshots(wsRoot) {
  try {
    const p = snapshotPaths(wsRoot);
    if (!fs.existsSync(p.dir)) return [];
    return fs.readdirSync(p.dir).filter(f => f.endsWith(".json")).sort().reverse();
  } catch { return []; }
}

// ── 快照保留策略 ──
// 背景：快照每份内嵌 记忆日志.md 全文，而日志只增不减 → 旧快照是"新快照日志的前缀"，
// 信息高度冗余。此前快照在每次 server 启动时无条件写（archiveStateSections 内），
// 攒到 521 份 / 98.7MB 且全仓没有任何读取方（restoreSnapshot 零调用）——只写不读。
// 现在：写入改成"真要改记忆时才写"，并强制保留上限，避免无界增长。
export const SNAPSHOT_KEEP = 30;
export const SNAPSHOT_MAX_BYTES = 12 * 1024 * 1024;

// 按保留上限清理旧快照，返回 { removed, kept, bytes }（只删 .json，不碰其它文件）
export function pruneSnapshots(wsRoot, { keep = SNAPSHOT_KEEP, maxBytes = SNAPSHOT_MAX_BYTES } = {}) {
  try {
    const p = snapshotPaths(wsRoot);
    const names = listSnapshots(wsRoot); // 新的在前
    if (!names.length) return { ok: true, removed: 0, kept: 0, bytes: 0 };
    const sizeOf = (n) => { try { return fs.statSync(path.join(p.dir, n)).size; } catch { return 0; } };
    // 先按份数截断，再从最旧端按总字节数继续截断（至少保留 1 份）
    let survivors = names.slice(0, Math.max(1, keep));
    let bytes = survivors.reduce((s, n) => s + sizeOf(n), 0);
    while (survivors.length > 1 && bytes > maxBytes) {
      bytes -= sizeOf(survivors[survivors.length - 1]);
      survivors = survivors.slice(0, -1);
    }
    const keepSet = new Set(survivors);
    let removed = 0;
    for (const n of names) {
      if (keepSet.has(n)) continue;
      try { fs.unlinkSync(path.join(p.dir, n)); removed++; } catch {}
    }
    return { ok: true, removed, kept: survivors.length, bytes };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

// ── 对话轮次计数：每 N 轮存一份（原实现读 listSnapshots().length 取模，
//    但 0 触发后份数恒为 1，1..19 都不满足 %20 → 该分支一次都进不去，是死代码）──
export function tickSnapshot(wsRoot, every = 20, reason = "auto") {
  try {
    const p = snapshotPaths(wsRoot);
    fs.mkdirSync(p.dir, { recursive: true });
    const f = path.join(p.dir, ".tick");
    let n = 0;
    try { n = parseInt(fs.readFileSync(f, "utf8"), 10) || 0; } catch {}
    n += 1;
    if (n < every) { atomicWriteText(f, String(n)); return { ok: true, ticked: n, saved: false }; }
    atomicWriteText(f, "0");
    const r = saveSnapshot(wsRoot, reason);
    pruneSnapshots(wsRoot);
    return { ok: true, ticked: 0, saved: !!r?.ok, id: r?.id };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

// ══ P3 自动提炼：从记忆日志把"跨会话仍有效"的偏好/约定提炼进固定记忆核心约定节（去重）══
export function distillMemory(wsRoot, { max = 60, scanN = 80, dryRun = false } = {}) {
  try {
    const paths = memoryPaths(wsRoot);
    if (!fs.existsSync(paths.log)) return { ok: false, reason: "无记忆日志" };
    const raw = fs.readFileSync(paths.log, "utf8");
    const blocks = raw.split(/\n### /).filter(b => b.trim()).slice(-scanN); // 扫描最近 scanN 条
    const fixed = fs.existsSync(paths.fixed) ? fs.readFileSync(paths.fixed, "utf8") : "";
    const distilled = [];
    for (const b of blocks) {
      const m = b.match(/要点：([\s\S]*)/);
      if (!m) continue;
      const noteText = m[1];
      // 要点本身必须含强偏好词（避免标签误标导致噪音）
      if (!/以后|记住|我习惯|我喜欢|统一用|用这个|就按|不要|别|必须|一直|默认用|坚持|避免/.test(noteText)) continue;
      let line = noteText.trim().split("\n")[0].replace(/^[✅⚠️📌]\s*/, "").trim().slice(0, 120);
      if (line.length < 8) continue;
      if (fixed.includes(line.slice(0, 20))) continue; // 已在固定记忆
      // 偏好词位置越靠前 = 偏好表达越明确 → 优先提炼
      const pos = noteText.search(/以后|记住|我习惯|我喜欢|统一用|用这个|就按|不要|别|必须|一直|默认用|坚持|避免/);
      distilled.push({ line, pos: pos >= 0 ? pos : 999 });
    }
    distilled.sort((a, b) => a.pos - b.pos);
    const out = distilled.slice(0, max).map(x => x.line);
    if (dryRun || !out.length) return { ok: true, distilled: out, applied: 0 };
    // 先快照再改（重要文件保护）
    try { saveSnapshot(wsRoot, "distill-before"); } catch {}
    let s = fixed;
    const anchor = "## 核心约定";
    let applied = 0;
    if (s.includes(anchor)) {
      const idx = s.indexOf(anchor);
      const nextIdx = s.indexOf("\n## ", idx + anchor.length);
      const endIdx = nextIdx > 0 ? nextIdx : s.length;
      let section = s.slice(idx, endIdx);
      for (const line of out) {
        if (!section.includes(line.slice(0, 20))) { section = section.replace(/\n*$/, "") + `\n- ${line}`; applied++; }
      }
      s = s.slice(0, idx) + section + s.slice(endIdx);
    } else {
      s = s.replace(/\n*$/, "") + `\n\n${anchor}\n` + out.map(l => `- ${l}`).join("\n") + "\n";
      applied = out.length;
    }
    atomicWriteText(paths.fixed, s);
    try { syncMemoryToTui(); } catch {}
    return { ok: true, distilled, applied };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

// ══ P4 状态节归档：固定记忆"当前状态"节超过 N 个时，最旧的压缩为一行（防无限膨胀）══
// 实现：每次重新扫描 + 只归档最旧的（文件里状态节最新在前），避免 index 失效错乱
export function archiveStateSections(wsRoot, keep = 5) {
  try {
    const paths = memoryPaths(wsRoot);
    if (!fs.existsSync(paths.fixed)) return { ok: false, reason: "无固定记忆" };
    let s = fs.readFileSync(paths.fixed, "utf8");
    let archived = 0;
    while (true) {
      const secs = [...s.matchAll(/## 当前状态（[^）]*）/g)]
        .filter(m => !s.slice(m.index + m[0].length, m.index + m[0].length + 12).includes("已归档")); // 排除已归档节
      if (secs.length <= keep) break;
      const m = secs[secs.length - 1]; // 最旧的 = 文件末尾的
      const idx = m.index;
      const nextIdx = s.indexOf("\n## ", idx + m[0].length);
      const endIdx = nextIdx > 0 ? nextIdx : s.length;
      const section = s.slice(idx, endIdx);
      const first = (section.match(/\n- (.{0,70})/) || [])[1] || "";
      const title = m[0].replace(/^## /, "").split("·")[0].trim();
      s = s.slice(0, idx) + `## ${title}（已归档）· ${first}\n` + s.slice(endIdx);
      archived++;
    }
    // 只有在真的改写了固定记忆时才存快照；没有归档动作就是纯读，不该留下快照文件。
    // （原实现在循环前无条件 saveSnapshot，server 每次启动都会落一份 → 521 份 / 98.7MB）
    if (archived > 0) {
      try { saveSnapshot(wsRoot, "archive-before"); } catch {}
      atomicWriteText(paths.fixed, s);
      try { pruneSnapshots(wsRoot); } catch {}
      try { syncMemoryToTui(); } catch {}
    }
    return { ok: true, archived };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

// 回退到某快照
export function restoreSnapshot(wsRoot, id) {
  try {
    const p = snapshotPaths(wsRoot);
    const f = path.join(p.dir, id.endsWith(".json") ? id : id + ".json");
    if (!fs.existsSync(f)) return { ok: false, reason: "快照不存在" };
    const snap = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const [name, content] of Object.entries(snap.files || {})) {
      const target = name === "记忆.md" ? memoryPaths(wsRoot).fixed
        : name === "记忆日志.md" ? memoryPaths(wsRoot).log
        : name === CORRECTION_FILE ? correctionPaths(wsRoot).file
        : relationPaths(wsRoot).file;
      if (target) { fs.mkdirSync(path.dirname(target), { recursive: true }); atomicWriteText(target, content); }
    }
    try { syncMemoryToTui(); } catch {}
    return { ok: true, id: snap.id, reason: snap.reason };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}
