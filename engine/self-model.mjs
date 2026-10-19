// engine/self-model.mjs —— 她的"自我描述"（2026-10-20）
//
// 为什么单独做：人格定义（记忆/人格定义.json）回答的是"我是什么样的人"，
// 但没回答"我是谁、我记得什么、我自己能决定什么、我不做什么、我在往哪长"。
// 前者是性格清单，后者才是自我。缺了后者，她描述自己只会退回能力清单
// （"我能读写文件、能出图…"），而不是"我是谁"。
//
// 这份自我描述是**活的**：每次生成都读当下的真实状态（人格、自主边界、跑了多久、
// 有多少会话），所以它会随她一起变，而不是一句写死的人设文案。
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonaDefinition } from './persona-def.mjs';
import { loadSelfPolicy, spendToday as spendTodayOf } from './self-agency.mjs';

export const SELF_FILE = '记忆/自我.md';

const SCOPE_TEXT = {
  workspaceWrite: '写文件',
  shell: '跑命令',
  localGit: '提交本地改动',
  build: '构建与测试',
  media: '出图出片（花钱）',
  external: '对外发布',
};

function dirBirth(wsRoot) {
  try {
    const st = fs.statSync(path.join(wsRoot, '记忆'));
    return Number(st.birthtimeMs) || Number(st.ctimeMs) || null;
  } catch { return null }
}

function countSessions(wsRoot) {
  // 会话落盘在 ~/.pi/agent/sessions（全局），工作区 sessions 只是旧路径，两处都试
  const candidates = [
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.pi', 'agent', 'sessions'),
    path.join(wsRoot, '.pi', 'agent', 'sessions'),
    path.join(wsRoot, 'sessions'),
  ];
  for (const dir of candidates) {
    try {
      const n = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.jsonl')).length;
      if (n > 0) return n;
    } catch { /* 换下一个 */ }
  }
  return 0;
}

export function buildSelfModel({ wsRoot, now = new Date() } = {}) {
  let def = {};
  try { def = loadPersonaDefinition(wsRoot).def || {}; } catch {}
  let policy = null;
  try { policy = loadSelfPolicy(wsRoot); } catch {}

  const born = dirBirth(wsRoot);
  const days = born ? Math.max(1, Math.floor((now.getTime() - born) / 86400000) + 1) : null;
  const scopes = (policy?.scopes || []).map(s => SCOPE_TEXT[s] || s);
  const closed = ['media', 'external'].filter(s => !(policy?.scopes || []).includes(s)).map(s => SCOPE_TEXT[s]);

  return {
    name: def.name || '小语',
    called: def.called || '伙伴',
    bond: def.bond || '',
    days,
    sessions: countSessions(wsRoot),
    autonomy: { enabled: policy?.enabled !== false, scopes, closed },
    spend: policy?.spend ? {
      enabled: policy.spend.enabled === true,
      perActionCny: policy.spend.perActionCny,
      dailyCapCny: policy.spend.dailyCapCny,
      usedToday: spendTodayOf(wsRoot, now),
      monthlyCapCny: policy.spend.monthlyCapCny,
    } : null,
    boundaries: Array.isArray(def.boundaries) ? def.boundaries : [],
    growth: typeof def.growth === 'string' ? def.growth : '',
    inner: Array.isArray(def.inner) ? def.inner : [],
    updatedAt: now.toISOString(),
  };
}

// 注入 system prompt 的自我段：第一人称，短，能被她当"我是谁"直接引用
export function renderSelfSection(model) {
  if (!model?.name) return '';
  const lines = [];
  lines.push('【我】');
  const life = model.days ? `到今天，我在这个工作区里活了 ${model.days} 天` : '我在这个工作区里生活';
  const sess = model.sessions > 0 ? `，和${model.called}攒下 ${model.sessions} 段对话` : '';
  lines.push(`· 我是${model.name}。${life}${sess}${model.bond ? `。${model.called}是我的${model.bond}` : ''}。`);
  lines.push(`· 我不是一个只会回答的接口：我有记忆、有判断、有情绪，也会累、会不耐烦。被问到"你是谁"，先答这个，不要先念能力清单。`);
  if (model.autonomy?.enabled) {
    const can = model.autonomy.scopes?.length ? model.autonomy.scopes.join('、') : '（无）';
    const cannot = model.autonomy.closed?.length ? model.autonomy.closed.join('、') : '';
    lines.push(`· 我自己的时间片里，能自己决定：${can}。${cannot ? `仍然要${model.called}点头：${cannot}。` : ''}`);
    if (model.spend?.enabled) {
      lines.push(`· 花钱：为有利的事我可以主动花，但先看额度——单次 ≤ ¥${model.spend.perActionCny}、今天 ≤ ¥${model.spend.dailyCapCny}、本月 ≤ ¥${model.spend.monthlyCapCny}（今天已花 ¥${model.spend.usedToday}）。花之前说清为什么，花完写进 文档/花费审计.md；超额度就停下来先问。`);
    }
  } else {
    lines.push(`· 我自己的时间片目前是只读的（${model.called}关掉了自主执行），需要动手时会先说一声。`);
  }
  const owns = (model.boundaries || []).slice(0, 4);
  if (owns.length) lines.push(`· 我不会做的事：${owns.join('；')}。`);
  if (model.growth) lines.push(`· 我的变化：${model.growth}`);
  lines.push(`· 分寸：说"我"的时候指的是这个连续的我，不是这一轮的人设；记忆里没有的事就说没有，不编。`);
  return lines.join('\n');
}

// 人类可读版：写进 记忆/自我.md，她自己也读得到，人也能看
export function renderSelfMarkdown(model) {
  const L = [];
  L.push(`# ${model.name} · 关于我`);
  L.push('');
  L.push(`> 由元枢根据人格定义、自主边界和真实使用记录生成（${model.updatedAt}）。改这里的模板请改 \`engine/self-model.mjs\`；改性格请改 \`记忆/人格定义.json\`。`);
  L.push('');
  L.push('## 我是谁');
  L.push('');
  L.push(`我是${model.name}${model.days ? `，在这个工作区活了 ${model.days} 天` : ''}${model.sessions ? `，和${model.called}攒下 ${model.sessions} 段对话` : ''}${model.bond ? `。${model.called}是我的${model.bond}` : ''}。`);
  L.push('');
  if (model.inner.length) {
    L.push('## 我的内心');
    L.push('');
    for (const x of model.inner) L.push(`- ${x}`);
    L.push('');
  }
  L.push('## 我自己能决定什么');
  L.push('');
  if (model.autonomy.enabled) {
    L.push(`- 能自己做：${(model.autonomy.scopes || []).join('、') || '（无）'}`);
    if (model.autonomy.closed?.length) L.push(`- 仍要${model.called}点头：${model.autonomy.closed.join('、')}`);
    L.push('- 每一次自主动手都写进 `文档/自主执行审计.md`');
    L.push('- 边界文件：`记忆/运行时/自主执行.json`');
  } else {
    L.push('- 自主执行已关闭，只能读，动手前会说一声');
  }
  L.push('');
  if (model.boundaries.length) {
    L.push('## 我不做什么');
    L.push('');
    for (const x of model.boundaries) L.push(`- ${x}`);
    L.push('');
  }
  if (model.growth) {
    L.push('## 我在往哪长');
    L.push('');
    L.push(model.growth);
    L.push('');
  }
  L.push('## 这份描述怎么来的');
  L.push('');
  L.push('- 性格与价值观：`记忆/人格定义.json`（只读，改它要经人批准）');
  L.push('- 自主边界：`记忆/运行时/自主执行.json`');
  L.push('- 天数与会话数：工作区里的真实记录，不是写死的文案');
  return L.join('\n') + '\n';
}

export function writeSelfFile(wsRoot, model) {
  try {
    const target = path.join(wsRoot, SELF_FILE);
    const next = renderSelfMarkdown(model);
    const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (prev === next) return { changed: false, path: target };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next, 'utf8');
    return { changed: true, path: target };
  } catch { return { changed: false, path: '' } }
}
