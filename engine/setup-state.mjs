// 首启向导状态：新装时 config.mjs 生成令牌的同时落一个 .setup-pending 标记，
// 向导走完（令牌 → 模型 → 灵魂）后删除。升级用户已有 .token，不会生成标记，不会误弹向导。
// 全部是纯函数、目录作参数，方便在临时目录里测。
import fs from 'node:fs';
import path from 'node:path';

export const SETUP_PENDING_FILE = '.setup-pending';
export const SETUP_REVIEWER = 'human-confirm:setup-wizard';
const MAX_LEN = { name: 20, called: 20 };

export function setupPendingPath(dir) { return path.join(dir, SETUP_PENDING_FILE); }

export function markSetupPending(dir) {
  try { fs.writeFileSync(setupPendingPath(dir), new Date().toISOString() + '\n', { mode: 0o600 }); return true; }
  catch { return false; }
}

export function isSetupPending(dir) {
  try { return fs.statSync(setupPendingPath(dir)).isFile(); } catch { return false; }
}

export function clearSetupPending(dir) {
  try { fs.unlinkSync(setupPendingPath(dir)); }
  catch (e) { if (e?.code !== 'ENOENT') throw e; }
}

// 首启领取令牌（Tauri 桌面端启动时不带 ?t=）：只认本机直连。
// cloudflared 隧道流量也来自 127.0.0.1，靠代理头 + Host 排除；DNS rebinding 靠 Host/Origin 白名单排除。
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'true-client-ip', 'via'];
export function isLocalSetupRequest(req, port) {
  const addr = String(req?.socket?.remoteAddress || '');
  if (!LOOPBACK.has(addr)) return false;
  const h = req?.headers || {};
  if (PROXY_HEADERS.some(k => h[k] !== undefined)) return false;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!hosts.has(String(h.host || '').toLowerCase())) return false;
  if (h.origin !== undefined && !hosts.has(String(h.origin).toLowerCase().replace(/^https?:\/\//, ''))) return false;
  return true;
}

// 向导只允许改名字和称呼；其余人格字段走灵魂页的正式审批流程。
export function normalizeSetupSoul(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('灵魂设定必须为对象');
  const patch = {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(MAX_LEN, key)) throw new Error(`向导不允许修改字段：${key}`);
    const v = typeof input[key] === 'string' ? input[key].trim() : '';
    if (!v) throw new Error(`${key === 'name' ? '名字' : '称呼'}不能为空`);
    if (v.length > MAX_LEN[key]) throw new Error(`${key === 'name' ? '名字' : '称呼'}最多 ${MAX_LEN[key]} 个字`);
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error('不能包含控制字符');
    patch[key] = v;
  }
  return patch;
}

// 通过人格治理模块写入（同一套校验、快照、APPEND_SYSTEM 同步），reviewer 记为向导确认。
// 用户原样确认默认值时 prepare 会抛「没有需要保存的修改」，视为确认成功。
export function applySetupSoul(governance, input) {
  const patch = normalizeSetupSoul(input);
  const current = governance.read();
  if (!Object.keys(patch).length) return { ok: true, unchanged: true, definition: current.definition };
  let plan;
  try {
    plan = governance.prepare('apply', { definition: patch, expectedRevision: current.revision, reason: '首启向导：用户确认灵魂设定' });
  } catch (e) {
    if (e?.message === '没有需要保存的修改') return { ok: true, unchanged: true, definition: current.definition };
    throw e;
  }
  const r = governance.commit(plan, SETUP_REVIEWER);
  return { ok: true, unchanged: false, definition: r.definition };
}
