// engine/design-prefs.mjs —— 设计偏好回流
//
// 2026-10-19 伙伴：「我看别人说 lovart 越用，那个智能体越会」→「接上吧」。
// Lovart 那套"越用越会"的真身是：**把每一次返工记下来，下次生成前先用上**。
// 这里做最小闭环：
//   1) 每次委托跑完自动回流：巡检问题/生成失败 → avoid 条目；干净通过 → prefer 条目；
//   2) 下次组装提示词时，把高权重的偏好/禁忌拼进 prompt；
//   3) 手动入口：用户说"以后别用蓝紫色"这类话时也能记（工具 design_prefs）。
//
// 只记"可复用的取舍"，不记整段对话；同一条重复出现只加权重，不重复堆条目。

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomic-io.mjs';

export const PREFS_FILE = path.join('记忆', '运行时', '设计偏好.json');
export const MAX_ITEMS = 60;
const MAX_TEXT = 160;

const fileOf = (wsRoot) => path.join(wsRoot, PREFS_FILE);
const nowIso = (now) => new Date(typeof now === 'function' ? now() : (now ?? Date.now())).toISOString();
const clip = (s, n = MAX_TEXT) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function loadPrefs(wsRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(wsRoot), 'utf8'));
    return { v: 1, items: Array.isArray(data?.items) ? data.items : [] };
  } catch { return { v: 1, items: [] } }
}

function savePrefs(wsRoot, store) {
  const file = fileOf(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, { v: 1, items: store.items.slice(0, MAX_ITEMS) });
}

/** 记一条偏好；同 kind + 同文本只加权重。 */
export function remember(wsRoot, { kind = 'avoid', text, evidence = '', now = Date.now } = {}) {
  const body = clip(text);
  if (!body) return null;
  const store = loadPrefs(wsRoot);
  const hit = store.items.find((i) => i.kind === kind && i.text === body);
  if (hit) {
    hit.weight = Math.min(20, (hit.weight || 1) + 1);
    hit.lastSeenAt = nowIso(now);
    if (evidence) hit.evidence = clip(evidence, 200);
  } else {
    store.items.unshift({
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
      kind, text: body, evidence: clip(evidence, 200),
      weight: 1, createdAt: nowIso(now), lastSeenAt: nowIso(now), uses: 0,
    });
  }
  savePrefs(wsRoot, store);
  return body;
}

/** 手动删一条（用户说"这条不适用了"）。 */
export function forget(wsRoot, id) {
  const store = loadPrefs(wsRoot);
  const before = store.items.length;
  store.items = store.items.filter((i) => i.id !== String(id || '') && i.text !== String(id || ''));
  savePrefs(wsRoot, store);
  return { ok: store.items.length !== before };
}

/**
 * 从一次委托的结果里学：失败/巡检问题 → avoid；干净通过 → prefer（低权重，仅当有主体时）。
 * @returns {{added:number, skipped:string}}
 */
export function learnFromReport(wsRoot, commission = {}, report = {}, { now = Date.now } = {}) {
  let added = 0;
  for (const issue of Array.isArray(report.issues) ? report.issues : []) {
    if (issue.level === 'info') continue;
    if (remember(wsRoot, { kind: 'avoid', text: issue.message, evidence: `${commission.title || ''} · 巡检 ${issue.code}`, now })) added++;
  }
  for (const err of Array.isArray(report.errors) ? report.errors : []) {
    if (remember(wsRoot, { kind: 'avoid', text: `交付失败：${err.error}`, evidence: `${commission.title || ''} · ${err.name}`, now })) added++;
  }
  // 干净通过：只有"有主体 + 无问题"才值得当成可用方向，否则会把空图也学进去
  if (report.ok && commission.subject && !(report.issues || []).length && !(report.errors || []).length) {
    const text = `${commission.subject}${commission.goal ? `｜${clip(commission.goal, 60)}` : ''}`;
    if (remember(wsRoot, { kind: 'prefer', text, evidence: `${commission.title || ''} · 通过`, now })) added++;
  }
  return { added, skipped: '' };
}

/**
 * 拼进提示词的偏好块。只取权重最高的几条，且明确标注来源是"过往结果"，避免模型当成硬指令。
 */
export function prefsBlock(wsRoot, { limit = 4 } = {}) {
  const store = loadPrefs(wsRoot);
  if (!store.items.length) return '';
  const byWeight = [...store.items].sort((a, b) => (b.weight || 1) - (a.weight || 1) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  const avoid = byWeight.filter((i) => i.kind === 'avoid').slice(0, limit);
  const prefer = byWeight.filter((i) => i.kind === 'prefer').slice(0, limit);
  const lines = [];
  // 条目本身常以"避免/不要"开头，和分栏标题会撞车，这里剥一次
  const strip = (s, re) => String(s || '').replace(re, '').trim();
  if (avoid.length) lines.push(`避免（过往出过问题）：${avoid.map((i) => strip(i.text, /^(避免|不要|别用|禁止)/)).join('；')}`);
  if (prefer.length) lines.push(`可参考（过往通过的取向）：${prefer.map((i) => strip(i.text, /^(可参考|优先|要用|保持)/)).join('；')}`);
  if (!lines.length) return '';
  // 记一次使用，用于之后判断哪条真的有用
  for (const i of [...avoid, ...prefer]) i.uses = (i.uses || 0) + 1;
  savePrefs(wsRoot, store);
  return lines.join('\n');
}

export const DESIGN_PREFS_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'design_prefs',
    description: '设计偏好台账：用户说"以后别用蓝紫色/都要留白/交付必须 16:9"这类长期要求时，用 add 记下来（下次委托生成前自动带上）；list 看现有取舍；remove 删掉不再适用的。不要用它记一次性的要求。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'] },
        kind: { type: 'string', enum: ['avoid', 'prefer'], description: 'avoid=以后别这样；prefer=以后照这个来' },
        text: { type: 'string', description: '一句话写清取舍，例如「避免蓝紫色调」「交付必须 16:9」' },
        id: { type: 'string', description: 'remove 用' },
      },
      required: ['action'],
    },
  },
};

export function designPrefsExecutors(wsRoot, { now = Date.now } = {}) {
  return {
    design_prefs: async (args = {}) => {
      const action = String(args.action || 'list');
      if (action === 'add') {
        const text = clip(args.text);
        if (!text) return { text: '要记的偏好是空的。', isError: true };
        remember(wsRoot, { kind: args.kind === 'prefer' ? 'prefer' : 'avoid', text, evidence: '用户口述', now });
        return { text: `已记：${args.kind === 'prefer' ? '以后照这个来' : '以后避免'} —— ${text}`, isError: false };
      }
      if (action === 'remove') {
        const r = forget(wsRoot, args.id);
        return r.ok ? { text: '已删除。', isError: false } : { text: '没找到这条。', isError: true };
      }
      const items = loadPrefs(wsRoot).items;
      if (!items.length) return { text: '还没有偏好记录。', isError: false };
      const lines = items.slice(0, 20).map((i) => `${i.kind === 'prefer' ? '✅' : '🚫'} ${i.text}（权重 ${i.weight}，用了 ${i.uses || 0} 次）`);
      return { text: lines.join('\n'), isError: false };
    },
  };
}
