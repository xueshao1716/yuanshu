// engine/cultivation/approval-requests.mjs —— 授权中心的"待确认授权"队列
//
// 2026-10-18 伙伴：「新授权应该出现在等我确认」。查下来发现：
//   · 授权中心只聚合 confirmRegistry（内存里的危险操作确认）；
//   · agent-pending 里虽然写着 cultivation-policy 这个类型，却**没有任何注册点**；
//   · 培养自己的会话授权只给 60 秒窗口，是给"人在场点一下"设计的，不适合异步看。
//
// 所以这里补一层：小语把"她做不到、必须人点头"的请求写成一条申请（落盘、可跨重启、30 分钟有效），
// 同时在确认注册表里挂一张卡。人在授权中心点批准 → 用**会话授权**把那一件事执行一次；
// 拒绝 → 记录拒绝原因，她下次调用能看到。
//
// 安全边界：申请里存的是**完整命令**（目前只收 policy.set），批准时原样执行；
// 不能借此获得电脑操作/文件/工具权限——会话授权的 allowedActions 仍是最终边界。

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../atomic-io.mjs';

export const REQUESTS_FILE = path.join('记忆', '运行时', '培养授权申请.json');
export const REQUEST_TTL_MS = 30 * 60 * 1000;
const MAX_REQUESTS = 40;

function fileOf(wsRoot) { return path.join(wsRoot, REQUESTS_FILE) }

function readAll(wsRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(wsRoot), 'utf8'));
    return Array.isArray(data?.requests) ? data.requests : [];
  } catch { return [] }
}

function writeAll(wsRoot, requests) {
  const file = fileOf(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, { v: 1, requests: requests.slice(-MAX_REQUESTS) });
}

const nowMs = (now) => (typeof now === 'function' ? Number(now()) : Number(now ?? Date.now()));

/** 过期即失效：读的时候顺手过滤，不用后台定时器。 */
export function listRequests(wsRoot, { now = Date.now } = {}) {
  const t = nowMs(now);
  return readAll(wsRoot).map((r) => ({ ...r, expired: r.status === 'pending' && t >= r.expiresAt }));
}

export function pendingRequests(wsRoot, opts) {
  return listRequests(wsRoot, opts).filter((r) => r.status === 'pending' && !r.expired);
}

export function createRequest(wsRoot, { sessionId, command, reason, now = Date.now, ttlMs = REQUEST_TTL_MS } = {}) {
  const t = nowMs(now);
  const requests = readAll(wsRoot);
  const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const row = {
    id,
    sessionId: String(sessionId || ''),
    kind: String(command?.action || 'unknown'),
    command,
    reason: String(reason || '').slice(0, 300),
    status: 'pending',
    createdAt: new Date(t).toISOString(),
    expiresAt: t + Math.max(60_000, Number(ttlMs) || REQUEST_TTL_MS),
  };
  writeAll(wsRoot, [...requests.filter((r) => r.status === 'pending' && t < r.expiresAt), row]);
  return row;
}

export function findRequest(wsRoot, id) {
  return readAll(wsRoot).find((r) => r.id === String(id || '')) || null;
}

export function settleRequest(wsRoot, id, status, { by = '', note = '', now = Date.now } = {}) {
  const requests = readAll(wsRoot);
  const hit = requests.find((r) => r.id === String(id || ''));
  if (!hit) return { ok: false, reason: 'request_not_found' };
  if (hit.status !== 'pending') return { ok: false, reason: 'request_already_settled', status: hit.status };
  hit.status = status;
  hit.settledAt = new Date(nowMs(now)).toISOString();
  hit.settledBy = String(by || '').slice(0, 120);
  hit.note = String(note || '').slice(0, 300);
  writeAll(wsRoot, requests);
  return { ok: true, request: hit };
}
