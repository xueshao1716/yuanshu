// engine/self-agency.mjs —— 自主执行通道（2026-10-20）
//
// 问题（用户原话）："得让她为自己活，而不是干啥都有权限卡，她做不了"。
// 现状：她自己发起的轮次（定时任务/自省）只有 read / web_search / search_files，
//       于是她能看、能写报告，但什么也做不了；每件要动手的事都得等主人开口。
//
// 这条通道给的是**有边界、可审计**的行动能力，不是把权限全开：
//   workspaceWrite  写工作空间内的文件（凭据/系统目录仍由红线拦）
//   shell           跑本机命令（红线命令仍走审批）
//   localGit        本地 add/commit（不含 push）
//   build           构建/测试
//   media           出图/出片/配音（花钱，默认关）
//   external        对外发布/发送（默认关，永远要人点头）
//
// 每一次动作写进 文档/自主执行审计.md，并按 dailyActions 限频防跑飞。
// 与 engine/autonomy.mjs 的区别：那份管"能不能自己升级自己"（A/B/C 级），
// 这份管"她自己的时间片里能不能动手"，两者互不复用，避免把授权状搞混。
import fs from 'node:fs';
import path from 'node:path';

export const SELF_POLICY_FILE = '记忆/运行时/自主执行.json';
export const SELF_AUDIT_FILE = '文档/自主执行审计.md';
export const SELF_SCOPES = ['workspaceWrite', 'shell', 'localGit', 'build', 'media', 'external'];

export const DEFAULT_SELF_POLICY = Object.freeze({
  enabled: true,
  // 2026-10-20：主人放开花钱（media）——她可以为「有利的事」主动付出，但受 spend 额度约束。
  scopes: ['workspaceWrite', 'shell', 'localGit', 'build', 'media'],
  dailyActions: 200,
  notifyOnAction: false,
  // 2026-10-20：主人明确"花钱没事，只要花钱有度，为有利的事可以主动付出"。
  // 放开花钱，但三条约束不能少：单次上限、每日上限、每笔留理由。
  spend: { enabled: true, perActionCny: 30, dailyCapCny: 200, monthlyCapCny: 2000, requireReason: true },
  note: '她能自己写、能自己跑、能在额度内自己花钱（为有利的事）；对外发布仍要人点头。',
});

export function selfPolicyPath(wsRoot) { return path.join(wsRoot, SELF_POLICY_FILE); }
export function selfAuditPath(wsRoot) { return path.join(wsRoot, SELF_AUDIT_FILE); }

function normalize(raw) {
  const scopes = Array.isArray(raw?.scopes)
    ? raw.scopes.filter(s => SELF_SCOPES.includes(s))
    : [...DEFAULT_SELF_POLICY.scopes];
  return {
    enabled: raw?.enabled === undefined ? DEFAULT_SELF_POLICY.enabled : raw.enabled === true,
    scopes,
    dailyActions: Number.isSafeInteger(raw?.dailyActions) && raw.dailyActions >= 0
      ? raw.dailyActions : DEFAULT_SELF_POLICY.dailyActions,
    notifyOnAction: raw?.notifyOnAction === true,
    spend: {
      enabled: raw?.spend?.enabled === undefined ? DEFAULT_SELF_POLICY.spend.enabled : raw.spend.enabled === true,
      perActionCny: Number.isFinite(raw?.spend?.perActionCny) && raw.spend.perActionCny >= 0
        ? raw.spend.perActionCny : DEFAULT_SELF_POLICY.spend.perActionCny,
      dailyCapCny: Number.isFinite(raw?.spend?.dailyCapCny) && raw.spend.dailyCapCny >= 0
        ? raw.spend.dailyCapCny : DEFAULT_SELF_POLICY.spend.dailyCapCny,
      monthlyCapCny: Number.isFinite(raw?.spend?.monthlyCapCny) && raw.spend.monthlyCapCny >= 0
        ? raw.spend.monthlyCapCny : DEFAULT_SELF_POLICY.spend.monthlyCapCny,
      requireReason: raw?.spend?.requireReason === undefined ? DEFAULT_SELF_POLICY.spend.requireReason : raw.spend.requireReason === true,
    },
    note: typeof raw?.note === 'string' ? raw.note : DEFAULT_SELF_POLICY.note,
  };
}

// ── 花钱：额度、留理由、可核 ─────────────────────────────────────────
export const SELF_SPEND_FILE = '文档/花费审计.md';
export function selfSpendPath(wsRoot) { return path.join(wsRoot, SELF_SPEND_FILE); }

export function recordSpend(wsRoot, entry = {}, { now = new Date(), fsMod = fs } = {}) {
  try {
    const amount = Number(entry.cny);
    if (!Number.isFinite(amount) || amount < 0) return false;
    const target = selfSpendPath(wsRoot);
    fsMod.mkdirSync(path.dirname(target), { recursive: true });
    if (!fsMod.existsSync(target)) {
      fsMod.writeFileSync(target,
        '# 花费审计\n\n> 她自己决定花钱的每一笔：什么时候、为什么、花了多少。超额度必须先说。\n\n', 'utf8');
    }
    const at = now instanceof Date ? now.toISOString() : String(now);
    const row = '- ' + at + ' · ¥' + amount.toFixed(2) + ' · ' + (entry.action || '生成')
      + ' · 理由：' + String(entry.reason || '未写').slice(0, 200)
      + (entry.detail ? ' · ' + String(entry.detail).slice(0, 120) : '') + '\n';
    fsMod.appendFileSync(target, row, 'utf8');
    return true;
  } catch { return false }
}

export function spendToday(wsRoot, { now = new Date(), fsMod = fs } = {}) {
  try {
    const day = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
    let total = 0;
    for (const line of fsMod.readFileSync(selfSpendPath(wsRoot), 'utf8').split('\n')) {
      if (!line.startsWith('- ' + day)) continue;
      const m = line.match(/¥\s*([0-9]+(?:\.[0-9]+)?)/);
      if (m) total += Number(m[1]);
    }
    return Math.round(total * 100) / 100;
  } catch { return 0 }
}

// 本月累计（跨天看月账，日额管不住月账）
export function spendThisMonth(wsRoot, { now = new Date(), fsMod = fs } = {}) {
  try {
    const month = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 7);
    let total = 0;
    for (const line of fsMod.readFileSync(selfSpendPath(wsRoot), 'utf8').split('\n')) {
      if (!line.startsWith('- ' + month)) continue;
      const m = line.match(/¥\s*([0-9]+(?:\.[0-9]+)?)/);
      if (m) total += Number(m[1]);
    }
    return Math.round(total * 100) / 100;
  } catch { return 0 }
}

// 还能不能花：额度够 + 单笔不超
export function canSpend(policy, wsRoot, cny, opts) {
  const spend = policy?.spend;
  if (!spend?.enabled) return { ok: false, reason: '自主花钱已关（记忆/运行时/自主执行.json 的 spend.enabled）' };
  const amount = Number(cny) || 0;
  if (amount > spend.perActionCny) return { ok: false, reason: '单笔 ¥' + amount + ' 超过单次上限 ¥' + spend.perActionCny };
  const used = spendToday(wsRoot, opts);
  if (used + amount > spend.dailyCapCny) return { ok: false, reason: '今天已花 ¥' + used + '，再加 ¥' + amount + ' 超过每日上限 ¥' + spend.dailyCapCny };
  if (Number.isFinite(spend.monthlyCapCny)) {
    const monthUsed = spendThisMonth(wsRoot, opts);
    if (monthUsed + amount > spend.monthlyCapCny) return { ok: false, reason: '本月已花 ¥' + monthUsed + '，再加 ¥' + amount + ' 超过每月上限 ¥' + spend.monthlyCapCny };
  }
  return { ok: true, used, remaining: Math.max(0, spend.dailyCapCny - used - amount) };
}

export function loadSelfPolicy(wsRoot, fsMod = fs) {
  try {
    return normalize(JSON.parse(fsMod.readFileSync(selfPolicyPath(wsRoot), 'utf8')));
  } catch { return normalize(null) }
}

export function saveSelfPolicy(wsRoot, next, fsMod = fs) {
  const merged = normalize({ ...loadSelfPolicy(wsRoot, fsMod), ...next });
  const target = selfPolicyPath(wsRoot);
  fsMod.mkdirSync(path.dirname(target), { recursive: true });
  fsMod.writeFileSync(target, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function allows(policy, scope) {
  if (!policy?.enabled) return false;
  if (!SELF_SCOPES.includes(scope)) return false;
  return Array.isArray(policy.scopes) && policy.scopes.includes(scope);
}

// 工具名 → scope。没列出的工具一律不放开（保守：新工具默认不给她）。
const TOOL_SCOPE = {
  read: null, search_files: null, web_search: null,        // 只读，永远允许
  write: 'workspaceWrite', edit: 'workspaceWrite',
  todo_write: 'workspaceWrite', todo_read: null, plan_files: 'workspaceWrite',
  bash: 'shell',
  generate_image: 'media', generate_video: 'media', generate_tts: 'media',
  share_project: 'external',
};

export function selfTools(all, policy) {
  const tools = Array.isArray(all) ? all : [];
  return tools.filter((tool) => {
    const name = tool?.function?.name || tool?.name;
    if (!name) return false;
    if (!Object.hasOwn(TOOL_SCOPE, name)) return false;   // 未知工具不放开
    const scope = TOOL_SCOPE[name];
    return scope === null || allows(policy, scope);
  });
}

export function recordSelfAction(wsRoot, entry = {}, { now = new Date(), fsMod = fs } = {}) {
  try {
    const target = selfAuditPath(wsRoot);
    fsMod.mkdirSync(path.dirname(target), { recursive: true });
    if (!fsMod.existsSync(target)) {
      fsMod.writeFileSync(target,
        '# 自主执行审计\n\n> 她自己发起、自己动手做完的事。只读动作不记，越线动作在这里留痕。\n\n', 'utf8');
    }
    const at = now instanceof Date ? now.toISOString() : String(now);
    const row = `- ${at} · ${entry.task || '自主轮次'} · ${entry.action || 'run'}` +
      `${entry.detail ? ' · ' + String(entry.detail).slice(0, 240) : ''}` +
      `${entry.result ? ' → ' + String(entry.result).slice(0, 240) : ''}\n`;
    fsMod.appendFileSync(target, row, 'utf8');
    return true;
  } catch { return false }
}

export function actionsToday(wsRoot, { now = new Date(), fsMod = fs } = {}) {
  try {
    const text = fsMod.readFileSync(selfAuditPath(wsRoot), 'utf8');
    const day = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
    return text.split('\n').filter(line => line.startsWith('- ' + day)).length;
  } catch { return 0 }
}

export function withinDailyLimit(wsRoot, policy, opts) {
  return actionsToday(wsRoot, opts) < (policy?.dailyActions ?? DEFAULT_SELF_POLICY.dailyActions);
}
