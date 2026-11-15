// ===== team-board.mjs —— 团队共享任务看板（2026-11-15）=====
//
// 缺的是什么（对标 dsh 的 team_task_* 语义）：天团成员各跑各的，contract 只管各自交付，
// 没人能声明"这块我占了""这块依赖你"。这张板子就是那份共享清单：
//   · owner 谁在干、blockedBy 依赖谁、writeScopes 要改哪些文件/目录
//   · ready = 所有 blockedBy 已 completed 且状态还是 pending（没被占用）——领活前先看它
//   · claim 带 expectedRevision：revision 不匹配就是有人先改过，返回冲突、不覆盖
//   · summary 把 writeScopes 重叠的 in_progress 任务标成 conflicts——同一文件两个人改 = 事故
//
// 存储：<工作区>/记忆/运行时/团队看板/<teamId>.json（teamId = 天团运行/检查点编号）
//   · 原子写（reviewAtomicWrite）＋ 写前留一份 <file>.bak（只留一个，覆盖旧的）
//   · 读有上限；损坏/结构不对时 fail closed：不猜、不覆盖（宁可报错，也不吃掉别人的活）
//   · 单进程内是同步读改写：Node 单线程、中间没有 await，临界区不会自己交错；
//     跨进程的丢更新窗口与处置写在最后一段注释里。
import { randomUUID } from 'node:crypto';
import { reviewStoragePath, reviewAtomicWrite } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';
import { scopesOverlap } from './claim-board.mjs';

export const BOARD_REL_DIR = '记忆/运行时/团队看板';
export const TASK_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'blocked']);
export const TEAM_BOARD_ACTIONS = Object.freeze(['create', 'list', 'claim', 'complete', 'release', 'summary']);
export const MAX_TASKS = 120;
export const MAX_SUBJECT_CHARS = 200;
export const MAX_DETAIL_CHARS = 4000;
export const MAX_RESULT_CHARS = 4000;
export const MAX_SCOPES = 20;
export const MAX_TEAM_ID_CHARS = 100;
export const MAX_BOARD_BYTES = 2_000_000;
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_OWNER_CHARS = 60;
const STATUS_ICON = Object.freeze({ pending: '☐', in_progress: '⏳', completed: '✅', blocked: '⛔' });

// 默认根：server 显式传 wsRoot；单测/脚本可以调 configureTeamBoard 固定一个临时工作区。
let _wsRoot = '';
export function configureTeamBoard({ wsRoot = '' } = {}) { _wsRoot = String(wsRoot || '').trim(); }

function rootOf(opts = {}) {
  const root = String(opts?.wsRoot || _wsRoot || process.env.YUANSHU_CWD || process.cwd()).trim();
  if (!root) throw new Error('缺少工作区根（wsRoot）');
  return root;
}

function nowIso() { return new Date().toISOString(); }

function assertTeamId(teamId) {
  const id = typeof teamId === 'string' ? teamId.trim() : '';
  if (!id) throw new Error('缺少 teamId（团队编号；不填默认当前运行编号）');
  if (id.length > MAX_TEAM_ID_CHARS || !TEAM_ID_RE.test(id)) {
    throw new Error(`teamId 只能由字母、数字、下划线、点、连字符组成（≤${MAX_TEAM_ID_CHARS} 字符）`);
  }
  return id;
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function ownerName(value) {
  return cleanText(value, MAX_OWNER_CHARS) || null;
}

function normalizeIdList(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
  const out = [];
  for (const item of list) {
    const id = cleanText(item, 80);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_SCOPES) break;
  }
  return out;
}

function normalizeScopes(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
  const out = [];
  for (const item of list) {
    const scope = cleanText(item, 300).replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (scope && !out.includes(scope)) out.push(scope);
    if (out.length >= MAX_SCOPES) break;
  }
  return out;
}

function newTaskId() {
  return `t-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

export function teamBoardPath(teamId, opts = {}) {
  return reviewStoragePath(rootOf(opts), `${BOARD_REL_DIR}/${assertTeamId(teamId)}.json`);
}

function emptyBoard(teamId) {
  const at = nowIso();
  return { teamId, createdAt: at, updatedAt: at, tasks: [] };
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanText(raw.id, 80);
  const subject = cleanText(raw.subject, MAX_SUBJECT_CHARS);
  if (!id || !subject) return null;
  // 状态/版本号不合规 = 文件不可信：返回 null 让 readBoard 整块 fail closed，不静默改写。
  if (!TASK_STATUSES.includes(raw.status)) return null;
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) return null;
  const status = raw.status;
  const revision = raw.revision;
  return {
    id, subject, detail: cleanText(raw.detail, MAX_DETAIL_CHARS), status,
    owner: ownerName(raw.owner),
    blockedBy: normalizeIdList(raw.blockedBy),
    writeScopes: normalizeScopes(raw.writeScopes),
    result: typeof raw.result === 'string' ? cleanText(raw.result, MAX_RESULT_CHARS) : null,
    completedAt: cleanText(raw.completedAt, 40) || null,
    revision,
  };
}

/** 读一块看板；不存在返回 null（正常情况，不抛）。损坏则抛错，绝不静默重建。 */
export function readBoard(teamId, opts = {}) {
  const id = assertTeamId(teamId);
  const file = teamBoardPath(id, opts);
  let buffer;
  try { buffer = readReviewBounded(file, MAX_BOARD_BYTES); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`团队看板读取失败：${String(e?.message || e).slice(0, 120)}`);
  }
  let raw;
  try { raw = JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error('团队看板文件损坏（不是合法 JSON），未自动覆盖'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.tasks)) throw new Error('团队看板结构无效，未自动覆盖');
  if (raw.teamId !== id) throw new Error('团队看板编号与文件名不一致，未自动覆盖');
  const tasks = raw.tasks.map((item, index) => {
    const task = normalizeTask(item);
    if (!task) throw new Error(`团队看板第 ${index + 1} 条任务不可读，未自动覆盖`);
    return task;
  });
  return {
    teamId: id,
    createdAt: cleanText(raw.createdAt, 40) || nowIso(),
    updatedAt: cleanText(raw.updatedAt, 40) || nowIso(),
    tasks,
  };
}

function writeBoard(board, opts = {}) {
  const file = teamBoardPath(board.teamId, opts);
  board.updatedAt = nowIso();
  // 写前备份一次即可：只留一个 <file>.bak，覆盖旧的；备份失败不挡本次写入（板子本身是提示层）。
  try {
    const previous = readReviewBounded(file, MAX_BOARD_BYTES).toString('utf8');
    try { reviewAtomicWrite(`${file}.bak`, previous); } catch {}
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  reviewAtomicWrite(file, JSON.stringify(board));
  return board;
}

/** 建团队时落一张空板；已存在则原样返回（resume 不重置任务）。 */
export function ensureBoard(teamId, opts = {}) {
  return readBoard(teamId, opts) || writeBoard(emptyBoard(assertTeamId(teamId)), opts);
}

// ── 任务视图：ready / 依赖未完成清单都是算出来的，不落盘（落盘就会和真实状态漂移）──
function completedIds(board) {
  return new Set(board.tasks.filter((task) => task.status === 'completed').map((task) => task.id));
}

function taskView(task, done) {
  const pendingBlockedBy = task.blockedBy.filter((id) => !done.has(id));
  return { ...task, ready: task.status === 'pending' && pendingBlockedBy.length === 0, pendingBlockedBy };
}

function brief(task) {
  return { id: task.id, subject: task.subject, owner: task.owner, status: task.status, revision: task.revision };
}

function revisionConflict(task, expected) {
  if (expected === undefined || expected === null) return null;
  const revision = Number(expected);
  if (Number.isInteger(revision) && revision === task.revision) return null;
  return { ok: false, conflict: true, revision: task.revision, task: brief(task),
    error: `revision 冲突：看板上是 ${task.revision}，你带的是 ${expected}；有人先改过，请重新 list 再决定（未覆盖）` };
}

function mutate(teamId, opts, change) {
  let id;
  try { id = assertTeamId(teamId); }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  let board;
  try { board = readBoard(id, opts); }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  if (!board) return { ok: false, missing: true, error: `看板 ${id} 不存在：先用 action:"create" 建任务（或核对 teamId）` };
  const outcome = change(board);
  if (!outcome?.ok || outcome.already) return outcome;
  try { writeBoard(board, opts); }
  catch (e) { return { ok: false, error: `看板写入失败（改动未生效）：${String(e?.message || e).slice(0, 160)}` }; }
  return outcome;
}

/**
 * 新建任务。
 * @param {string} teamId 团队编号
 * @param {{subject:string, detail?:string, blockedBy?:string[], writeScopes?:string[], owner?:string}} input
 * @param {{wsRoot?:string}} [opts]
 * @returns {{ok:true, task:object}|{ok:false, error:string}}
 */
export function createTask(teamId, input = {}, opts = {}) {
  let id;
  try { id = assertTeamId(teamId); }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  const subject = cleanText(input?.subject, MAX_SUBJECT_CHARS);
  if (!subject) return { ok: false, error: `create 需要 subject（一句话，最多 ${MAX_SUBJECT_CHARS} 字）` };
  let board;
  try { board = readBoard(id, opts) || emptyBoard(id); }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  if (board.tasks.length >= MAX_TASKS) {
    return { ok: false, error: `看板已有 ${board.tasks.length} 条任务（上限 ${MAX_TASKS}）：先清理已完成的条目，或换一块看板` };
  }
  const blockedBy = normalizeIdList(input?.blockedBy);
  const known = new Set(board.tasks.map((task) => task.id));
  const unknown = blockedBy.filter((dep) => !known.has(dep));
  if (unknown.length) return { ok: false, error: `blockedBy 里有不存在的任务：${unknown.join(', ')}（依赖只能引用同一块看板上已有的任务）` };
  const task = {
    id: newTaskId(),
    subject,
    detail: cleanText(input?.detail, MAX_DETAIL_CHARS),
    status: 'pending',
    owner: ownerName(input?.owner),
    blockedBy,
    writeScopes: normalizeScopes(input?.writeScopes),
    result: null,
    completedAt: null,
    revision: 1,
  };
  board.tasks.push(task);
  try { writeBoard(board, opts); }
  catch (e) { return { ok: false, error: `看板写入失败（任务未建）：${String(e?.message || e).slice(0, 160)}` }; }
  return { ok: true, task: { ...task } };
}

/**
 * 列任务。缺省过滤全部；ready=true 只留「依赖全完成且没被占用」的。
 * teamId 不存在 → 空列表（不炸）。
 */
export function listTasks(teamId, filter = {}, opts = {}) {
  let id;
  try { id = assertTeamId(teamId); }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  const status = cleanText(filter?.status, 40);
  if (status && !TASK_STATUSES.includes(status)) return { ok: false, error: `status 只能是 ${TASK_STATUSES.join(' / ')}` };
  const owner = ownerName(filter?.owner);
  let board;
  try { board = readBoard(id, opts); }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  if (!board) return { ok: true, teamId: id, total: 0, missing: true, tasks: [] };
  const done = completedIds(board);
  let tasks = board.tasks.map((task) => taskView(task, done));
  if (status) tasks = tasks.filter((task) => task.status === status);
  if (owner) tasks = tasks.filter((task) => task.owner === owner);
  if (filter?.ready === true) tasks = tasks.filter((task) => task.ready);
  return { ok: true, teamId: id, total: board.tasks.length, tasks };
}

/**
 * 认领（乐观并发）：expectedRevision 与看板不一致 → 冲突且不覆盖。
 * 同一 owner 重复认领幂等；别人已占 / 依赖未完成 / 已完成 → 拒绝。
 */
export function claimTask(teamId, taskId, owner, opts = {}) {
  const who = ownerName(owner);
  if (!who) return { ok: false, error: 'claim 需要 owner（谁在干）' };
  return mutate(teamId, opts, (board) => {
    const task = board.tasks.find((item) => item.id === taskId);
    if (!task) return { ok: false, error: `没有任务 ${taskId}` };
    if (task.status === 'in_progress' && task.owner === who) {
      const stale = revisionConflict(task, opts?.expectedRevision);
      return stale ? stale : { ok: true, already: true, task: brief(task) };
    }
    const stale = revisionConflict(task, opts?.expectedRevision);
    if (stale) return stale;
    if (task.status === 'in_progress') return { ok: false, occupied: true, owner: task.owner, task: brief(task), error: `「${task.subject}」已被 ${task.owner} 占用` };
    if (task.status === 'completed') return { ok: false, error: '任务已完成，不能领取' };
    if (task.status === 'blocked') return { ok: false, error: '任务处于 blocked：先解除阻塞（editTask 回 pending）再领' };
    const pending = task.blockedBy.filter((dep) => board.tasks.find((item) => item.id === dep)?.status !== 'completed');
    if (pending.length) return { ok: false, blocked: true, blockedBy: pending, error: `依赖未完成：${pending.join(', ')}（先把依赖 complete）` };
    task.status = 'in_progress';
    task.owner = who;
    task.revision += 1;
    return { ok: true, task: { ...task } };
  });
}

/** 完成：只有 in_progress 且 owner 对得上才能完成；结果写进 result。 */
export function completeTask(teamId, taskId, owner, opts = {}) {
  const who = ownerName(owner);
  if (!who) return { ok: false, error: 'complete 需要 owner（谁做的）' };
  return mutate(teamId, opts, (board) => {
    const task = board.tasks.find((item) => item.id === taskId);
    if (!task) return { ok: false, error: `没有任务 ${taskId}` };
    if (task.status === 'completed') {
      return task.owner === who ? { ok: true, already: true, task: brief(task) } : { ok: false, error: '任务已经完成过了' };
    }
    const stale = revisionConflict(task, opts?.expectedRevision);
    if (stale) return stale;
    if (task.status !== 'in_progress') return { ok: false, error: `任务当前是 ${task.status}，只有 in_progress 才能 complete` };
    if (task.owner !== who) return { ok: false, error: `任务由 ${task.owner} 占用，${who} 不能替它完成` };
    task.status = 'completed';
    task.owner = who;
    task.result = cleanText(opts?.result, MAX_RESULT_CHARS) || null;
    task.completedAt = nowIso();
    task.revision += 1;
    return { ok: true, task: { ...task } };
  });
}

/** 释放：变回 pending、清 owner；别人的进行中任务不能替它释放。 */
export function releaseTask(teamId, taskId, owner, opts = {}) {
  const who = ownerName(owner);
  if (!who) return { ok: false, error: 'release 需要 owner（谁释放）' };
  return mutate(teamId, opts, (board) => {
    const task = board.tasks.find((item) => item.id === taskId);
    if (!task) return { ok: false, error: `没有任务 ${taskId}` };
    if (task.status === 'completed') return { ok: false, error: '任务已完成，不能释放（已完成是终态）' };
    const stale = revisionConflict(task, opts?.expectedRevision);
    if (stale) return stale;
    if (task.status === 'in_progress' && task.owner && task.owner !== who) {
      return { ok: false, error: `任务由 ${task.owner} 占用，${who} 不能替它释放` };
    }
    task.status = 'pending';
    task.owner = null;
    task.result = null;
    task.completedAt = null;
    task.revision += 1;
    return { ok: true, task: { ...task } };
  });
}

/** 改任务（不动状态机；只改可编辑字段；status 只允许 pending<->blocked）。 */
export function editTask(teamId, taskId, patch = {}, opts = {}) {
  return mutate(teamId, opts, (board) => {
    const task = board.tasks.find((item) => item.id === taskId);
    if (!task) return { ok: false, error: `没有任务 ${taskId}` };
    const stale = revisionConflict(task, opts?.expectedRevision);
    if (stale) return stale;
    let changed = false;
    if (patch?.subject !== undefined) {
      const subject = cleanText(patch.subject, MAX_SUBJECT_CHARS);
      if (!subject) return { ok: false, error: 'subject 不能改成空' };
      if (subject !== task.subject) { task.subject = subject; changed = true; }
    }
    if (patch?.detail !== undefined) {
      const detail = cleanText(patch.detail, MAX_DETAIL_CHARS);
      if (detail !== task.detail) { task.detail = detail; changed = true; }
    }
    if (patch?.writeScopes !== undefined) {
      const scopes = normalizeScopes(patch.writeScopes);
      if (JSON.stringify(scopes) !== JSON.stringify(task.writeScopes)) { task.writeScopes = scopes; changed = true; }
    }
    if (patch?.status !== undefined) {
      if (!['pending', 'blocked'].includes(patch.status)) return { ok: false, error: 'edit 只能把状态改成 pending / blocked；完成与认领走 complete / claim' };
      if (task.status !== patch.status) {
        if (task.status === 'completed') return { ok: false, error: '已完成的任务不能改状态' };
        task.status = patch.status;
        if (patch.status === 'pending') task.owner = null;
        changed = true;
      }
    }
    if (!changed) return { ok: true, already: true, task: { ...task } };
    task.revision += 1;
    return { ok: true, task: { ...task } };
  });
}

/** 改依赖（会检查引用存在、不能自依赖、不能成环）。 */
export function setDependencies(teamId, taskId, blockedBy, opts = {}) {
  return mutate(teamId, opts, (board) => {
    const task = board.tasks.find((item) => item.id === taskId);
    if (!task) return { ok: false, error: `没有任务 ${taskId}` };
    const stale = revisionConflict(task, opts?.expectedRevision);
    if (stale) return stale;
    const deps = normalizeIdList(blockedBy);
    if (deps.includes(taskId)) return { ok: false, error: '不能依赖自己' };
    const known = new Set(board.tasks.map((item) => item.id));
    const unknown = deps.filter((dep) => !known.has(dep));
    if (unknown.length) return { ok: false, error: `依赖里有不存在的任务：${unknown.join(', ')}` };
    const reaches = (from, target) => {
      const seen = new Set();
      const stack = [from];
      while (stack.length) {
        const current = stack.pop();
        if (current === target) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        const node = board.tasks.find((item) => item.id === current);
        for (const dep of node?.blockedBy || []) stack.push(dep);
      }
      return false;
    };
    const cycle = deps.filter((dep) => reaches(dep, taskId));
    if (cycle.length) return { ok: false, error: `依赖成环：${cycle.join(', ')} 已经（间接）依赖本任务` };
    if (JSON.stringify(task.blockedBy) === JSON.stringify(deps)) return { ok: true, already: true, task: { ...task } };
    task.blockedBy = deps;
    task.revision += 1;
    return { ok: true, task: { ...task } };
  });
}

/**
 * 总览：{ total, byStatus, unowned, ready, inProgress, conflicts }
 * conflicts = 两个不同 in_progress 任务的 writeScopes 重叠（同一文件两个人改）。
 */
export function boardSummary(teamId, opts = {}) {
  let id;
  try { id = assertTeamId(teamId); }
  catch (e) { return { ok: false, teamId: String(teamId || ''), error: String(e?.message || e).slice(0, 200) }; }
  let board;
  try { board = readBoard(id, opts); }
  catch (e) { return { ok: false, teamId: id, error: String(e?.message || e).slice(0, 200) }; }
  const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
  if (!board) {
    return { ok: true, teamId: id, total: 0, missing: true, byStatus, unowned: 0, ready: [], inProgress: [], conflicts: [] };
  }
  const done = completedIds(board);
  const views = board.tasks.map((task) => taskView(task, done));
  for (const task of views) byStatus[task.status] += 1;
  const ready = views.filter((task) => task.ready);
  const inProgress = views.filter((task) => task.status === 'in_progress');
  const conflicts = [];
  for (let i = 0; i < inProgress.length; i++) {
    for (let j = i + 1; j < inProgress.length; j++) {
      const a = inProgress[i], b = inProgress[j];
      if (!scopesOverlap(a.writeScopes, b.writeScopes)) continue;
      conflicts.push({
        taskIds: [a.id, b.id],
        owners: [a.owner, b.owner],
        scope: a.writeScopes.filter((scope) => b.writeScopes.some((other) => scopesOverlap([scope], [other]))),
      });
    }
  }
  return {
    ok: true, teamId: id, total: views.length, byStatus,
    unowned: views.filter((task) => !task.owner && task.status !== 'completed').length,
    ready: ready.map(brief), inProgress: inProgress.map(brief), conflicts,
  };
}

/** 注入给每个成员的共享上下文（空板/没任务返回空串，不污染提示词）。 */
export function formatBoardContext(summary = {}) {
  if (!summary || summary.ok === false || !summary.total) return '';
  const by = summary.byStatus || {};
  const lines = [`【团队共享看板 · ${summary.teamId}】共 ${summary.total} 项：待办 ${by.pending || 0} / 进行中 ${by.in_progress || 0} / 已完成 ${by.completed || 0} / 阻塞 ${by.blocked || 0}${summary.unowned ? `；未认领 ${summary.unowned}` : ''}`];
  const ready = Array.isArray(summary.ready) ? summary.ready : [];
  if (ready.length) {
    lines.push('可领（依赖已完成、没人占）：' + ready.slice(0, 8).map((task) => `${task.id} ${task.subject}`).join('；')
      + (ready.length > 8 ? ` …另 ${ready.length - 8} 项` : ''));
  }
  const doing = Array.isArray(summary.inProgress) ? summary.inProgress : [];
  if (doing.length) {
    lines.push('进行中：' + doing.slice(0, 8).map((task) => `${task.id} ${task.subject}（${task.owner || '无主'}）`).join('；'));
  }
  if (Array.isArray(summary.conflicts) && summary.conflicts.length) {
    lines.push('⚠️ 写范围冲突（同一文件别两个人改）：' + summary.conflicts.slice(0, 4).map((item) => `${item.taskIds.join('×')} 抢 ${item.scope.join(',')}`).join('；'));
  }
  lines.push('这是共享上下文：动手前按上面的 owner / 写范围避开别人；你负责的活做完要回看板 complete。');
  return lines.join('\n');
}

/** 收尾提示（只是提示，不阻断）：还有 pending/in_progress 就列出来。 */
export function formatBoardReminder(summary = {}) {
  if (!summary || summary.ok === false || !summary.total) return '';
  const by = summary.byStatus || {};
  const unfinished = (by.pending || 0) + (by.in_progress || 0);
  if (!unfinished) return '';
  const doing = Array.isArray(summary.inProgress) ? summary.inProgress : [];
  const ready = Array.isArray(summary.ready) ? summary.ready : [];
  const items = [...doing, ...ready].slice(0, 5)
    .map((task) => `${task.id} ${String(task.subject || '').slice(0, 40)}${task.owner ? `（${task.owner}）` : ''}`);
  return `\n\n【看板】还有 ${unfinished} 项没收尾（待办 ${by.pending || 0} / 进行中 ${by.in_progress || 0}）：`
    + `${items.join('；')}${items.length ? ' …' : ''}\n只是提示，不影响本次交付；这些活要么继续做，要么在看板上 release / 说明。`;
}

// ── 工具化：一个 team_board 工具带 6 个动作（避免工具表膨胀）──
const TEAM_BOARD_DESCRIPTION = '团队共享任务看板：团队成员把要干的活写成任务，用它声明「这块我占了」「这块依赖你」'
  + '（落盘 记忆/运行时/团队看板/<teamId>.json）。'
  + '动作：create 建任务（subject 必填；blockedBy 填依赖的任务 id；writeScopes 填要改的文件/目录）| '
  + 'list 领活前先看 | claim 认领 | complete 做完写 result | release 放弃 | summary 看整体（会报写范围冲突）。'
  + '**纪律**：① 领活前先 list（ready:true 只看就绪且没人占的）；② claim 必须带 expectedRevision（就是 list 里的 revision）——'
  + 'revision 不匹配说明有人先改过，不要盲覆盖；③ 同一文件不要两个 in_progress，writeScopes 写清要改的路径，summary 会把重叠标成 conflicts；'
  + '④ 做完立刻 complete 并写 result，卡住就 release，别占着坑。'
  + '依赖未完成的任务不能 claim；别人已占的任务返回占用者；看板只是共享清单，不替代验收。';

export const TEAM_BOARD_TOOL = {
  type: 'function',
  function: {
    name: 'team_board',
    description: TEAM_BOARD_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...TEAM_BOARD_ACTIONS], description: 'create 建任务 / list 列任务 / claim 认领 / complete 完成 / release 释放 / summary 总览' },
        teamId: { type: 'string', description: '团队编号；不填默认当前运行编号（服务端补），跨轮要沿用同一个' },
        taskId: { type: 'string', description: '任务 id（claim / complete / release 必填）' },
        owner: { type: 'string', description: '成员名（claim / complete / release 必填；create 时可预填负责人，只是标注，占用仍要 claim）' },
        subject: { type: 'string', description: `任务一句话（create 必填，≤${MAX_SUBJECT_CHARS} 字）` },
        detail: { type: 'string', description: `补充说明 / 验收标准（≤${MAX_DETAIL_CHARS} 字）` },
        blockedBy: { type: 'array', items: { type: 'string' }, description: '依赖的任务 id：这些任务 completed 之前不算 ready，也不能 claim' },
        writeScopes: { type: 'array', items: { type: 'string' }, description: '要改的文件/目录（工作区相对路径）；两个 in_progress 任务范围重叠会被 summary 标成冲突' },
        expectedRevision: { type: 'number', description: 'claim 必带（complete / release 建议带）：list 里看到的 revision。不一致=有人先改过，返回冲突且不覆盖' },
        result: { type: 'string', description: `complete 时填：做完的结果（≤${MAX_RESULT_CHARS} 字）` },
        status: { type: 'string', enum: [...TASK_STATUSES], description: 'list 过滤用：只看某个状态' },
        ready: { type: 'boolean', description: 'list 过滤用：true 只返回就绪且没被占用的任务' },
      },
      required: ['action'],
    },
  },
};

function reply(text, isError = false, details = undefined) {
  return details === undefined ? { text, isError } : { text, isError, details };
}

function formatTaskLine(task) {
  const parts = [`${STATUS_ICON[task.status] || '·'} ${task.id} rev=${task.revision} ${task.subject}`];
  if (task.owner) parts.push(`owner=${task.owner}`);
  if (task.status === 'pending') parts.push(task.ready ? '可领' : '待依赖');
  if (task.pendingBlockedBy?.length) parts.push(`blockedBy=${task.pendingBlockedBy.join(',')}`);
  if (task.writeScopes?.length) parts.push(`写范围=${task.writeScopes.join(',')}`);
  return parts.join(' · ');
}

/**
 * team_board 执行器（server 的 extraToolExecutors 表里一行接上，照 verify_check 的方式）。
 * ctx: { wsRoot, teamId?（默认兜底，服务端用当前 runId）, runId? }
 */
export function executeTeamBoard(args = {}, ctx = {}) {
  const action = cleanText(args?.action, 40);
  if (!TEAM_BOARD_ACTIONS.includes(action)) return reply(`⛔ action 必须是 ${TEAM_BOARD_ACTIONS.join(' / ')}`, true);
  let teamId;
  try { teamId = assertTeamId(String(args?.teamId || ctx?.teamId || ctx?.runId || '')); }
  catch (e) { return reply(`⛔ ${String(e?.message || e).slice(0, 160)}`, true); }
  const opts = { wsRoot: ctx?.wsRoot };
  try {
    if (action === 'create') {
      const out = createTask(teamId, {
        subject: args?.subject, detail: args?.detail, blockedBy: args?.blockedBy,
        writeScopes: args?.writeScopes, owner: args?.owner,
      }, opts);
      if (!out.ok) return reply(`⛔ 建不了任务：${out.error}`, true, out);
      const task = out.task;
      return reply(`✅ 已建任务 ${task.id}「${task.subject}」（看板 ${teamId}，rev=${task.revision}，status=${task.status}${task.blockedBy.length ? `，依赖 ${task.blockedBy.join(',')}` : ''}）\n`
        + `下一位领活前先 list；claim 时 expectedRevision=${task.revision}。`, false, out);
    }
    if (action === 'list') {
      const out = listTasks(teamId, { status: args?.status, owner: args?.owner, ready: args?.ready === true }, opts);
      if (!out.ok) return reply(`⛔ 列不出来：${out.error}`, true, out);
      if (!out.tasks.length) return reply(out.missing ? `看板 ${teamId} 还不存在（还没有任务）。` : '没有符合条件的任务。', false, out);
      const by = Object.fromEntries(TASK_STATUSES.map((status) => [status, out.tasks.filter((task) => task.status === status).length]));
      const head = `看板 ${teamId}：共 ${out.total} 项（待办 ${by.pending} / 进行中 ${by.in_progress} / 已完成 ${by.completed} / 阻塞 ${by.blocked}）`;
      const tail = '\n\n提示：claim 要带 expectedRevision（上面的 rev=…）；同一文件别让两个任务同时 in_progress；依赖没完成的任务领不了。';
      return reply(`${head}\n${out.tasks.map(formatTaskLine).join('\n')}${tail}`, false, out);
    }
    if (action === 'claim') {
      if (!args?.taskId) return reply('⛔ claim 需要 taskId', true);
      if (!args?.owner) return reply('⛔ claim 需要 owner（谁在干）', true);
      if (args?.expectedRevision === undefined || args?.expectedRevision === null) {
        return reply('⛔ claim 必须带 expectedRevision（list 里看到的 revision）：没有它就是盲抢，会在并发时覆盖别人的占用。', true);
      }
      const out = claimTask(teamId, cleanText(args.taskId, 80), args.owner, { wsRoot: ctx?.wsRoot, expectedRevision: args.expectedRevision });
      if (!out.ok) return reply(`⛔ 领不了：${out.error}`, true, out);
      if (out.already) return reply(`✅ ${out.task.owner} 已经在做 ${out.task.id}（重复 claim 幂等，rev=${out.task.revision}）。`, false, out);
      return reply(`✅ 已认领 ${out.task.id}「${out.task.subject}」（owner=${out.task.owner}，rev=${out.task.revision}）。做完马上 complete 并写 result。`, false, out);
    }
    if (action === 'complete') {
      if (!args?.taskId) return reply('⛔ complete 需要 taskId', true);
      if (!args?.owner) return reply('⛔ complete 需要 owner', true);
      const out = completeTask(teamId, cleanText(args.taskId, 80), args.owner, {
        wsRoot: ctx?.wsRoot, expectedRevision: args?.expectedRevision, result: args?.result,
      });
      if (!out.ok) return reply(`⛔ 完不成：${out.error}`, true, out);
      if (out.already) return reply(`✅ ${out.task.id} 早就完成了（幂等）。`, false, out);
      return reply(`✅ 已完成 ${out.task.id}「${out.task.subject}」（rev=${out.task.revision}${out.task.result ? '，result 已记录' : ''}）。依赖它的任务现在可能变 ready，记得 list 一次。`, false, out);
    }
    if (action === 'release') {
      if (!args?.taskId) return reply('⛔ release 需要 taskId', true);
      if (!args?.owner) return reply('⛔ release 需要 owner', true);
      const out = releaseTask(teamId, cleanText(args.taskId, 80), args.owner, { wsRoot: ctx?.wsRoot, expectedRevision: args?.expectedRevision });
      if (!out.ok) return reply(`⛔ 释放不了：${out.error}`, true, out);
      return reply(`✅ 已释放 ${out.task.id}「${out.task.subject}」：回到 pending、owner 清空（rev=${out.task.revision}），别人可以领了。`, false, out);
    }
    // summary
    const summary = boardSummary(teamId, opts);
    if (summary.ok === false) return reply(`⛔ 看板读不出来：${summary.error}`, true, summary);
    if (summary.missing) return reply(`看板 ${teamId} 还不存在（空板）。`, false, summary);
    const by = summary.byStatus || {};
    const lines = [`看板 ${summary.teamId}：共 ${summary.total} 项（待办 ${by.pending} / 进行中 ${by.in_progress} / 已完成 ${by.completed} / 阻塞 ${by.blocked}；未认领 ${summary.unowned}）`];
    lines.push(`可领 ${summary.ready.length} 项${summary.ready.length ? '：' + summary.ready.map((task) => `${task.id} ${task.subject}`).join('；') : ''}`);
    lines.push(`进行中 ${summary.inProgress.length} 项${summary.inProgress.length ? '：' + summary.inProgress.map((task) => `${task.id} ${task.subject}（${task.owner || '无主'}）`).join('；') : ''}`);
    if (summary.conflicts.length) {
      lines.push('⚠️ 写范围冲突：' + summary.conflicts.map((item) => `${item.taskIds.join('×')}（${item.owners.join('/')}）抢 ${item.scope.join(',')}`).join('；'));
    } else {
      lines.push('写范围冲突：无');
    }
    return reply(lines.join('\n'), false, summary);
  } catch (e) {
    return reply(`team_board 出错：${String(e?.message || e).slice(0, 200)}`, true);
  }
}

// ── 并发写冲突（如实写在这里，不假装已解决）──
// 1) 同一进程内：所有变更都是同步「读 → 改 → 原子写」，中间没有 await，Node 单线程下不会交错；
//    真正的并发保护靠 revision：两个调用都基于旧 revision 时，后到的会被 revisionConflict 拒掉。
// 2) 跨进程（server 与天团子进程同时写同一块板）：read-modify-write 之间没有跨进程锁，
//    极端情况下后写者会覆盖前写者的一处 revision 递增。这里**不引入锁**是刻意的：
//    file-lock 给每次 claim 加锁会让看板（协作提示层）成为延迟与死锁来源，而看板里的活本身
//    还有 claim-board 认领板 + 交付验收在兜底。真需要跨进程强一致时，应把看板搬进 SQLite（memory-db 那套）。
