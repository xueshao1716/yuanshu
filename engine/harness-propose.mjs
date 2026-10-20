// engine/harness-propose.mjs —— Propose 步（2026-10-21）
//
// Harness² 的循环是 Propose → Probe → Compose。元枢只有 Probe（harness-probe，用历史跑分对照），
// 缺"提出候选改动"这一步：以前是夜间反思自由发挥，不是针对某条失败证据提两个候选。
//
// 这里刻意**只提议、不落地**：
//   · 候选写进 工程/经验库/候选日期.md 与索引 jsonl，状态一律 draft；
//   · 绝不写 记忆/harness/（那是 owner-only 组件），也绝不改协议/护栏；
//   · 采纳与否由人（或第二天的真实使用做 Probe）决定。
//
// 证据来源只有两处，都是既有落盘文件，不新增采集：
//   1) 文档/harness-试验.md       —— 每次改动的前后对照结论
//   2) 记忆/运行时/慢请求.jsonl   —— 慢请求（被拖住的具体路径）
import fs from 'node:fs';
import path from 'node:path';

export const PROPOSE_DIR = '工程/经验库/候选';
export const PROPOSE_INDEX = '工程/经验库/候选/索引.jsonl';
export const PROBE_LOG_FILE = '文档/harness-试验.md';
export const SLOW_LOG_FILE = '记忆/运行时/慢请求.jsonl';

/** 候选里允许指向的组件：只列 owner 可改的提示词类组件，避免"提议改代码"这种落不了地的建议 */
export const EDITABLE_COMPONENTS = ['system', 'guardrails', 'tools', 'skills', 'memory'];

function readLines(file, limit = 400) {
  try {
    const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return all.slice(-limit);
  } catch { return [] }
}

/** 收集证据：只读既有日志，不触发任何执行 */
export function collectEvidence(wsRoot, { slowLimit = 3, probeLimit = 5, hours = 48, now = Date.now() } = {}) {
  const probeRows = readLines(path.join(wsRoot, PROBE_LOG_FILE), 200)
    .filter(l => l.startsWith('- '))
    .slice(-probeLimit);
  const slow = readLines(path.join(wsRoot, SLOW_LOG_FILE), 500)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
    // 只留近 N 小时：几天前的卡顿已经不代表现在的行为
    .filter(s => {
      const ts = Date.parse(s.at || '');
      return Number.isFinite(ts) ? now - ts <= hours * 3600_000 : true;
    });
  // 按路径聚合取最慢的几条，避免同一路径刷屏
  const byPath = new Map();
  for (const s of slow) {
    const key = `${s.method || ''} ${s.path || ''}`;
    const prev = byPath.get(key);
    if (!prev || (s.durationMs || 0) > prev.durationMs) byPath.set(key, { key, durationMs: s.durationMs || 0, status: s.status, at: s.at });
  }
  const slowTop = [...byPath.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, slowLimit);
  return { probeRows, slowTop, hasEvidence: probeRows.length > 0 || slowTop.length > 0 };
}

/** 给模型的提议提示：短、限定两条、必须绑定证据 */
export function localDate(now = new Date()) {
  // sv-SE 的本地日期就是 YYYY-MM-DD，避免 UTC 跨天把 21 号写成 20 号
  try { return now.toLocaleDateString('sv-SE'); } catch { return now.toISOString().slice(0, 10) }
}

export function buildProposePrompt(evidence, { date = localDate() } = {}) {
  const lines = [
    '你是元枢的 harness 编辑。只做一件事：根据下面的证据，提出**两条**候选改动。',
    '规则：',
    '1. 第一条针对「通用能力缺陷」（规划/工具使用/上下文/并行/轮数），第二条针对「具体领域」（某类任务的做法）。',
    '2. 每条必须绑定一条具体证据（引用证据里的原话或数字），没有证据就不要编。',
    '3. 只能改这些组件：system / guardrails / tools / skills / memory；改不了代码、装不了依赖。',
    '4. 改动要小、可回滚、能被第二天的真实使用验证；不要提"重跑任务做AB"这种花时间的方案。',
    '5. 输出严格按下面的格式，不要有其它段落：',
    '## 候选 1',
    '- 组件：<system|guardrails|tools|skills|memory>',
    '- 证据：<引用>',
    '- 假设：<为什么这样改会好>',
    '- 改动：<一句话说明改哪一句/加哪一条>',
    '- 回滚：<怎么撤回>',
    '- 验证：<明天看什么指标>',
    '## 候选 2',
    '（同上）',
    '',
    `日期：${date}`,
    evidence.probeRows.length ? `\n【试验结论】\n${evidence.probeRows.join('\n')}` : '\n【试验结论】暂无',
    evidence.slowTop.length
      ? `\n【慢请求·近 48 小时】\n注意：这些是**服务自身的 HTTP 接口**，多数由前端轮询或内部调用触发，\n不一定是 agent 工具。若与 agent 的工具调用无关，就不要硬套到工具描述上；\n可以提"减少调用/改窄端点/加缓存"这类改动，但要先说明它在哪被调用。\n${evidence.slowTop.map(s => `- ${s.key} ${s.durationMs}ms status=${s.status}`).join('\n')}`
      : '',
  ];
  return lines.join('\n');
}

/** 解析模型输出；解析不出就返回空数组（宁可没候选，也不写垃圾） */
export function parseCandidates(text) {
  const out = [];
  const blocks = String(text || '').split(/^##\s*候选\s*\d+\s*$/m).slice(1);
  for (const block of blocks) {
    const pick = (label) => {
      const m = block.match(new RegExp(`-\\s*${label}\\s*[：:]\\s*(.+)`));
      return m ? m[1].trim() : '';
    };
    const c = {
      component: pick('组件'),
      evidence: pick('证据'),
      hypothesis: pick('假设'),
      change: pick('改动'),
      rollback: pick('回滚'),
      verify: pick('验证'),
    };
    if (c.change && c.component) out.push(c);
  }
  return out.slice(0, 2);
}

export function candidatesPath(wsRoot, date) { return path.join(wsRoot, PROPOSE_DIR, `候选-${date}.md`); }

/** 落盘：只写 工程/经验库/候选，状态 draft；并追加索引供后续 mark 使用 */
export function writeCandidates(wsRoot, { date, candidates, raw = '', source = 'propose' }) {
  if (!candidates.length) return { ok: false, reason: 'no-candidates' };
  const dir = path.join(wsRoot, PROPOSE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = candidatesPath(wsRoot, date);
  const head = [
    `# 候选改动 ${date}`,
    '',
    '> 由 harness-propose 生成：只提议，不落地。采纳需人批准；验证用第二天的真实使用（harness-probe）。',
    '',
  ].join('\n');
  const body = candidates.map((c, i) => [
    `## 候选 ${i + 1} · C-${date.replace(/-/g, '')}-${i + 1}`,
    `- 组件：${c.component}`,
    `- 证据：${c.evidence || '（未给出）'}`,
    `- 假设：${c.hypothesis || '（未给出）'}`,
    `- 改动：${c.change}`,
    `- 回滚：${c.rollback || '（未给出）'}`,
    `- 验证：${c.verify || '（未给出）'}`,
    '- 状态：draft',
  ].join('\n')).join('\n\n');
  fs.writeFileSync(file, `${head}${body}\n`, 'utf8');

  const idx = path.join(wsRoot, PROPOSE_INDEX);
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  const at = new Date().toISOString();
  const rows = candidates.map((c, i) => JSON.stringify({
    id: `C-${date.replace(/-/g, '')}-${i + 1}`, at, date, source,
    component: c.component, change: String(c.change).slice(0, 200), status: 'draft',
  }));
  fs.appendFileSync(idx, rows.join('\n') + '\n', 'utf8');
  return { ok: true, file, count: candidates.length };
}

export function listCandidates(wsRoot, { limit = 20 } = {}) {
  const rows = readLines(path.join(wsRoot, PROPOSE_INDEX), 500)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean);
  return rows.slice(-limit).reverse();
}

/** 更新状态：draft → verified / rejected / adopted（只改索引，不动候选正文） */
export function markCandidate(wsRoot, id, status, note = '') {
  const idx = path.join(wsRoot, PROPOSE_INDEX);
  const rows = readLines(idx, 2000);
  let hit = false;
  const next = rows.map(l => {
    try {
      const r = JSON.parse(l);
      if (r.id !== id) return l;
      hit = true;
      return JSON.stringify({ ...r, status, note: String(note || '').slice(0, 200), markedAt: new Date().toISOString() });
    } catch { return l }
  });
  if (!hit) return { ok: false, reason: 'not-found' };
  fs.writeFileSync(idx, next.join('\n') + '\n', 'utf8');
  return { ok: true, id, status };
}
