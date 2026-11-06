// engine/memory-hygiene.mjs —— 记忆卫生（2026-10-24）
//
// 借腾讯 Hy-Memory 的两个思路，但**不训练模型**，只用规则把同样的漏洞补上：
//   ① Probe（写入自检）：一条记忆写完后，检查原文里的数字/日期/名字有没有丢——丢了就是低质记忆。
//   ② Growth Penalty（增长惩罚）：记忆文件涨太快、太老还留着 → 归档到 .archive.md，主文件只留近期。
//
// 原则：**默认只出报告，不动物件**；apply 时先备份，归档是移动不是删除。
import fs from 'node:fs';
import path from 'node:path';

const REPORT = ['记忆', '运行时', '记忆卫生.json'];
const PROBE_LOG = ['记忆', '记忆自检.jsonl'];

// 默认上限：经验库 200 KB、记忆日志 500 KB（超出就把最老的条目归档）
const DEFAULT_LIMITS = {
  '工程/经验库/experience.md': { maxBytes: 300 * 1024, keepEntries: 100 },
  '记忆/记忆日志.md': { maxBytes: 700 * 1024, keepEntries: 250 },
};

/** 抽出记录里的"可核对事实"：数字、日期、英文专名、中文专名（粗略但够用） */
export function extractFacts(text) {
  const s = String(text || '');
  const facts = new Set();
  for (const m of s.matchAll(/\d{2,}(?:\.\d+)?/g)) facts.add(m[0]);
  for (const m of s.matchAll(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/g)) facts.add(m[0]);
  for (const m of s.matchAll(/\b[A-Za-z][A-Za-z0-9_.\-]{2,}\b/g)) facts.add(m[0]);
  // 中文书名号/引号里的名字
  for (const m of s.matchAll(/[《「"]([^》」"]{2,20})[》」"]/g)) facts.add(m[1]);
  return [...facts].filter((f) => f.length >= 2).slice(0, 80);
}

/** 写入自检：原文事实有多少写进了记忆 */
export function probeEntry({ sourceText = '', memoryText = '' } = {}) {
  const facts = extractFacts(sourceText);
  if (!facts.length) return { score: 1, kept: [], missing: [], note: '原文没有可核对事实' };
  const mem = String(memoryText || '');
  const kept = [];
  const missing = [];
  for (const f of facts) (mem.includes(f) ? kept : missing).push(f);
  const score = Math.round((kept.length / facts.length) * 100) / 100;
  return { score, kept, missing: missing.slice(0, 20) };
}

export function recordProbe(wsRoot, record) {
  try {
    const file = path.join(wsRoot, ...PROBE_LOG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', 'utf8');
    return true;
  } catch { return false }
}

/** 把文件按 `### ` 标题切成条目（没有标题就整体算一条） */
function splitEntries(text) {
  const lines = String(text).split('\n');
  const entries = [];
  const preamble = [];
  let cur = null;
  for (const line of lines) {
    if (/^#{2,4}\s/.test(line)) {
      if (cur) entries.push(cur);
      cur = { head: line, body: [line] };
    } else if (cur) cur.body.push(line);
    else preamble.push(line);
  }
  if (cur) entries.push(cur);
  // 文件开头的说明区（二级以下标题之前）不参与归档，永远留在主文件
  return { preamble: preamble.join('\n').trim(), entries: entries.map((e) => ({ head: e.head, text: e.body.join('\n') })) };
}

/** 规划：哪些文件超限、会归档多少条 */
export function planGrowth(wsRoot, limits = DEFAULT_LIMITS) {
  const report = [];
  for (const [rel, cfg] of Object.entries(limits)) {
    const file = path.join(wsRoot, ...rel.split('/'));
    let stat = null;
    try { stat = fs.statSync(file) } catch { continue }
    const text = fs.readFileSync(file, 'utf8');
    const { entries } = splitEntries(text);
    const overBytes = stat.size - cfg.maxBytes;
    const overCount = entries.length - cfg.keepEntries;
    if (overBytes <= 0 && overCount <= 0) {
      report.push({ file: rel, bytes: stat.size, entries: entries.length, action: 'keep' });
      continue;
    }
    const trimCount = Math.max(overCount, 0) || Math.min(entries.length, 10);
    const archive = entries.slice(0, Math.max(0, entries.length - cfg.keepEntries));
    report.push({
      file: rel, bytes: stat.size, entries: entries.length,
      action: 'trim', keepEntries: cfg.keepEntries,
      archiveEntries: archive.length, trimCount,
      archiveBytes: archive.reduce((n, e) => n + Buffer.byteLength(e.text) + 1, 0),
      overBytes,
    });
  }
  return report;
}

/** 执行归档：备份 → 老条目进 .archive.md → 主文件只留最近的 */
export function applyGrowth(wsRoot, limits = DEFAULT_LIMITS, now = new Date()) {
  const results = [];
  for (const [rel, cfg] of Object.entries(limits)) {
    const file = path.join(wsRoot, ...rel.split('/'));
    let stat = null;
    try { stat = fs.statSync(file) } catch { continue }
    const text = fs.readFileSync(file, 'utf8');
    const { preamble, entries } = splitEntries(text);
    if (entries.length <= cfg.keepEntries && stat.size <= cfg.maxBytes) { results.push({ file: rel, action: 'keep' }); continue }
    const keep = entries.slice(-cfg.keepEntries);
    const archive = entries.slice(0, Math.max(0, entries.length - cfg.keepEntries));
    if (!archive.length) { results.push({ file: rel, action: 'keep' }); continue }
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
    const archiveFile = `${file}.archive.md`;
    fs.appendFileSync(archiveFile, `\n\n<!-- archived ${stamp} -->\n` + archive.map((e) => e.text.trim()).join('\n\n') + '\n', 'utf8');
    fs.writeFileSync(file, (preamble ? preamble + '\n\n' : '') + keep.map((e) => e.text.trim()).join('\n\n') + '\n', 'utf8');
    results.push({ file: rel, action: 'archived', archived: archive.length, kept: keep.length, backup: `${path.basename(file)}.bak-${stamp}` });
  }
  try {
    const reportFile = path.join(wsRoot, ...REPORT);
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    const prev = (() => { try { return JSON.parse(fs.readFileSync(reportFile, 'utf8')) } catch { return {} } })();
    fs.writeFileSync(reportFile, JSON.stringify({ ...prev, at: new Date().toISOString(), last: results }, null, 2), 'utf8');
  } catch {}
  return results;
}

/** 每天最多跑一次（按日期戳） */
export function runHygieneDaily(wsRoot, now = new Date()) {
  const day = now.toLocaleDateString('sv-SE');
  const reportFile = path.join(wsRoot, ...REPORT);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(reportFile, 'utf8')) } catch {}
  if (prev.day === day) return { skipped: true, day };
  const plan = planGrowth(wsRoot);
  const applied = plan.some((p) => p.action === 'trim') ? applyGrowth(wsRoot, DEFAULT_LIMITS, now) : [];
  try {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify({ day, at: now.toISOString(), plan, applied }, null, 2), 'utf8');
  } catch {}
  return { skipped: false, day, plan, applied };
}
