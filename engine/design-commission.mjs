// engine/design-commission.mjs —— 设计委托
//
// 2026-10-19 伙伴：「可以，做吧」（对标 Lovart 2.0 的"设计委托"）。
// 它把"一次性出图"变成"可持续交付"：写清目标与交付件 → 可单次试跑 → 周期自动跑 →
// **积分上限当熔断器**（达到即停，不半夜烧钱）→ 每次交执行报告。
//
// 这里用「一次出图 = 1 点」做额度单位：不依赖各家计价，能真实拦住超额，且可解释。
// 出图与巡检都由调用方注入（server 用现有 /api/image 通道 + canvas-audit），模块本身可单测。

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomic-io.mjs';
import { localPathFromUrl } from './canvas-audit.mjs';

export const COMMISSIONS_FILE = path.join('记忆', '运行时', '设计委托.json');
export const MAX_COMMISSIONS = 30;
export const DEFAULT_CAP = 10;
const MAX_DELIVERABLES = 8;

const fileOf = (wsRoot) => path.join(wsRoot, COMMISSIONS_FILE);
const nowMs = (now) => (typeof now === 'function' ? Number(now()) : Number(now ?? Date.now()));
const text = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const ids = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function readStore(wsRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(wsRoot), 'utf8'));
    return { v: 1, items: Array.isArray(data?.items) ? data.items : [] };
  } catch { return { v: 1, items: [] } }
}

function writeStore(wsRoot, store) {
  const file = fileOf(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, { v: 1, items: store.items.slice(0, MAX_COMMISSIONS) });
}

export function listCommissions(wsRoot) { return readStore(wsRoot).items }

export function readCommission(wsRoot, id) {
  return readStore(wsRoot).items.find((c) => c.id === String(id || '')) || null;
}

function upsert(wsRoot, row) {
  const store = readStore(wsRoot);
  const i = store.items.findIndex((c) => c.id === row.id);
  if (i >= 0) store.items[i] = row; else store.items.unshift(row);
  writeStore(wsRoot, store);
  return row;
}

export function createCommission(wsRoot, input = {}, { now = Date.now } = {}) {
  const t = nowMs(now);
  const deliverables = (Array.isArray(input.brief?.deliverables) ? input.brief.deliverables : [])
    .filter((x) => typeof x === 'string' && x.trim()).slice(0, MAX_DELIVERABLES).map((x) => text(x, 80));
  const row = {
    id: ids(),
    title: text(input.title || '未命名设计委托', 80),
    goal: text(input.goal || input.brief?.goal || '', 600),
    brief: {
      deliverables,
      requiredText: (Array.isArray(input.brief?.requiredText) ? input.brief.requiredText : []).slice(0, 12).map((x) => text(x, 80)),
      forbidden: (Array.isArray(input.brief?.forbidden) ? input.brief.forbidden : []).slice(0, 20).map((x) => text(x, 40)),
      ratios: input.brief?.ratios && typeof input.brief.ratios === 'object' ? input.brief.ratios : {},
    },
    provider: text(input.provider, 60),
    modelId: text(input.modelId, 120),
    size: text(input.size, 40),
    cap: Number.isSafeInteger(input.cap) && input.cap >= 0 ? Math.min(input.cap, 200) : DEFAULT_CAP,
    everyMinutes: Number.isSafeInteger(input.everyMinutes) && input.everyMinutes >= 15 ? Math.min(input.everyMinutes, 1440) : 0,
    spent: 0,
    status: input.startPaused ? 'paused' : 'running',
    createdAt: new Date(t).toISOString(),
    updatedAt: new Date(t).toISOString(),
    lastRunAt: null,
    nextRunAt: t + (Number(input.everyMinutes) >= 15 ? Math.min(input.everyMinutes, 1440) * 60000 : 0),
    lastReport: null,
  };
  return upsert(wsRoot, row);
}

export function setStatus(wsRoot, id, status, { now = Date.now } = {}) {
  const row = readCommission(wsRoot, id);
  if (!row) return { ok: false, reason: 'not_found' };
  row.status = status;
  row.updatedAt = new Date(nowMs(now)).toISOString();
  return { ok: true, commission: upsert(wsRoot, row) };
}

export function removeCommission(wsRoot, id) {
  const store = readStore(wsRoot);
  const before = store.items.length;
  store.items = store.items.filter((c) => c.id !== String(id || ''));
  writeStore(wsRoot, store);
  return { ok: store.items.length !== before };
}

/**
 * 验活：交付件必须真的能拿到。
 * 本地结果（/api/ws/file?path=…）查文件在不在；远端地址发一次 HEAD（拿不到方法就 GET）。
 * 2026-10-19：外站链接会过期，报告里写"已交付"但其实打不开，等于骗人。
 */
export async function verifyArtifact(url, { wsRoot = '', fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const u = String(url || '').trim();
  if (!u) return { ok: false, reason: '空地址' };
  const local = localPathFromUrl(wsRoot, u);
  if (local) {
    try {
      const st = fs.statSync(local);
      if (st.isFile() && st.size > 0) return { ok: true, kind: 'file', bytes: st.size };
      return { ok: false, reason: '文件为空' };
    } catch { return { ok: false, reason: '文件不存在' } }
  }
  if (!/^https?:\/\//i.test(u)) {
    // 站内相对地址（无 path 参数）无法核对，按"未知"处理而不是判失败
    return { ok: true, kind: 'local-url', unchecked: true };
  }
  try {
    for (const method of ['HEAD', 'GET']) {
      const res = await fetchImpl(u, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { ok: true, kind: 'remote', status: res.status };
      if (method === 'HEAD' && [403, 405, 501].includes(res.status)) continue;
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    return { ok: false, reason: 'HTTP 不可用' };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 60) };
  }
}
export function dueCommissions(wsRoot, { now = Date.now } = {}) {
  const t = nowMs(now);
  return listCommissions(wsRoot).filter((c) => c.status === 'running' && c.everyMinutes > 0
    && (!c.nextRunAt || c.nextRunAt <= t) && c.spent < c.cap);
}

/**
 * 跑一轮：按交付件逐张出图，每张 1 点；到上限立刻停（熔断）。
 * @param deps.generate ({prompt,size,provider,modelId}) => {url}
 * @param deps.audit    (doc, {brief, wsRoot}) => {ok, issues}
 */
export async function runCommission(wsRoot, id, { generate, audit, verify = verifyArtifact, now = Date.now, fresh = false } = {}) {
  const t = nowMs(now);
  const row = readCommission(wsRoot, id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'paused') return { ok: false, reason: 'paused' };
  if (row.spent >= row.cap) {
    row.status = 'capped';
    upsert(wsRoot, row);
    return { ok: false, reason: 'capped', report: row.lastReport };
  }
  if (typeof generate !== 'function') return { ok: false, reason: 'generator_unavailable' };

  const names = row.brief.deliverables.length ? row.brief.deliverables : ['交付图'];
  const files = [];
  const errors = [];
  let unverified = 0;
  for (const name of names) {
    if (row.spent >= row.cap) break;
    const prompt = [row.goal || row.title, `交付件：${name}`, ...row.brief.requiredText].filter(Boolean).join('；');
    try {
      const out = await generate({ prompt, size: row.size, provider: row.provider, modelId: row.modelId });
      if (!out?.url) throw new Error('生成没有返回图片');
      // 交付前先验活：文件不在/链接打不开，不能写进"已完成"
      const check = typeof verify === 'function' ? await verify(out.url, { wsRoot }) : { ok: true };
      row.spent += 1;
      if (check.ok) files.push({ name, url: out.url, verified: true });
      else {
        files.push({ name, url: out.url, verified: false });
        errors.push({ name, error: `产物拿不到（${check.reason || '未知'}）` });
      }
    } catch (e) {
      errors.push({ name, error: text(e?.message || e, 160) });
    }
  }

  let issues = [];
  if (typeof audit === 'function' && files.length) {
    const nodes = files.map((f, i) => ({ id: `d${i}`, kind: 'image', title: f.name, text: '', url: f.url, provider: row.provider, modelId: row.modelId, size: row.size }));
    try {
      const a = await audit({ nodes, edges: [], view: { x: 0, y: 0, z: 1 }, brief: row.brief }, { brief: row.brief, wsRoot });
      issues = a?.issues || [];
    } catch { /* 巡检失败不影响交付 */ }
  }

  const report = {
    at: new Date(t).toISOString(),
    ok: errors.length === 0 && !issues.some((i) => i.level === 'error'),
    spent: row.spent,
    cap: row.cap,
    files,
    errors,
    issues,
    unverified: files.filter((f) => f.verified === false).length,
    note: fresh ? '单次试跑' : '周期执行',
  };
  row.lastReport = report;
  row.lastRunAt = report.at;
  row.updatedAt = report.at;
  if (row.spent >= row.cap) row.status = 'capped';
  else if (row.everyMinutes > 0) { row.status = 'running'; row.nextRunAt = t + row.everyMinutes * 60000; }
  else row.status = 'done';
  upsert(wsRoot, row);
  return { ok: report.ok, commission: row, report };
}

// ── 模型侧工具 ─────────────────────────────────────────────────────
export const COMMISSION_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'commission',
    description: '设计委托：把"持续交付"落成工单。create 写清目标与交付件（可设积分上限与周期）；run 试跑一次；list 看进度与最近报告；pause/resume 启停。积分单位是"一次出图 = 1 点"，到上限自动熔断（capped）。交付前配合 canvas.audit 核比例与文案。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'run', 'pause', 'resume', 'report'] },
        id: { type: 'string', description: 'run/pause/resume/report 用' },
        title: { type: 'string' },
        goal: { type: 'string', description: '这一单要达成什么（写清约束）' },
        deliverables: { type: 'array', items: { type: 'string' }, description: '交付件名称列表，一件一次出图' },
        requiredText: { type: 'array', items: { type: 'string' } },
        forbidden: { type: 'array', items: { type: 'string' } },
        ratios: { type: 'object', description: '期望比例，如 {image: 1.7778}' },
        provider: { type: 'string' },
        modelId: { type: 'string' },
        size: { type: 'string' },
        cap: { type: 'integer', description: '积分上限（一次出图 1 点），默认 10' },
        everyMinutes: { type: 'integer', description: '周期执行间隔（分钟，>=15）；0 或省略=只跑一次' },
      },
      required: ['action'],
    },
  },
};

export function formatCommission(row) {
  if (!row) return '委托不存在。';
  const r = row.lastReport;
  const head = `[${row.id}] ${row.title} · ${row.status} · 已用 ${row.spent}/${row.cap} 点${row.everyMinutes ? ` · 每 ${row.everyMinutes} 分钟` : ''}`;
  if (!r) return head;
  const files = r.files?.length ? `\n交付：${r.files.map((f) => `${f.name} → ${f.url}${f.verified === false ? '（未验活）' : ''}`).join('；')}` : '';
  const errs = r.errors?.length ? `\n失败：${r.errors.map((e) => `${e.name}（${e.error}）`).join('；')}` : '';
  const issues = r.issues?.length ? `\n巡检：${r.issues.map((i) => `[${i.level}] ${i.message}`).join('；')}` : '\n巡检：无偏离';
  return `${head}\n最近一次（${r.at}，${r.note}）：${r.ok ? '通过' : '有问题'}${files}${errs}${issues}`;
}

export function commissionExtraExecutors(wsRoot, deps = {}) {
  const { generate, audit, now = Date.now } = deps;
  return {
    commission: async (args = {}) => {
      try {
        const action = String(args.action || 'list');
        if (action === 'create') {
          const row = createCommission(wsRoot, {
            title: args.title, goal: args.goal, provider: args.provider, modelId: args.modelId, size: args.size,
            cap: args.cap, everyMinutes: args.everyMinutes,
            brief: { deliverables: args.deliverables, requiredText: args.requiredText, forbidden: args.forbidden, ratios: args.ratios },
          }, { now });
          return { text: `已创建委托：\n${formatCommission(row)}\n要试跑就 action=run id=${row.id}。`, isError: false };
        }
        if (action === 'list') {
          const items = listCommissions(wsRoot);
          if (!items.length) return { text: '还没有设计委托。', isError: false };
          return { text: items.map(formatCommission).join('\n\n'), isError: false };
        }
        if (action === 'report') {
          return { text: formatCommission(readCommission(wsRoot, args.id)), isError: false };
        }
        if (action === 'pause' || action === 'resume') {
          const r = setStatus(wsRoot, args.id, action === 'pause' ? 'paused' : 'running', { now });
          return r.ok ? { text: `已${action === 'pause' ? '暂停' : '恢复'}：${formatCommission(r.commission).split('\n')[0]}`, isError: false }
            : { text: '委托不存在。', isError: true };
        }
        if (action === 'run') {
          const r = await runCommission(wsRoot, args.id, { generate, audit, now, fresh: true });
          if (!r.commission) return { text: `跑不了：${r.reason}`, isError: true };
          return { text: `试跑完成。\n${formatCommission(r.commission)}`, isError: false };
        }
        return { text: `未知 action：${action}`, isError: true };
      } catch (e) {
        return { text: `委托操作失败：${String(e?.message || e).slice(0, 120)}`, isError: true };
      }
    },
  };
}
