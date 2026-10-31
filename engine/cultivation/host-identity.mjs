import fs from 'node:fs';
import {createHash} from 'node:crypto';

const object = value => value !== null && typeof value === 'object';
function canonicalDirectory(value) {
  if (typeof value !== 'string' || !value || fs.lstatSync(value).isSymbolicLink()) return null;
  const root = fs.realpathSync(value);
  if (!fs.statSync(root).isDirectory()) return null;
  return process.platform === 'win32' ? root.toLowerCase() : root;
}
const safeCanon = (v) => { try { return canonicalDirectory(v) } catch { return null } };
function synchronous(value) {
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    return null;
  }
  return value;
}

// Installed by the host only. A session ID, bearer or serialized capability is
// never sufficient: every use rechecks the real execution and live session.
export function createCultivationHostIdentity({wsRoot, resolveExecution, getEntry, canAccess}) {
  let root = null;
  try { root = canonicalDirectory(wsRoot); } catch { /* Disabled when scope is unavailable. */ }
  const workspace = root && createHash('sha256').update(root).digest('hex');
  const bindings = new WeakMap(), consumed = new WeakSet();
  const valid = (source, binding) => {
    try {
      const run = synchronous(resolveExecution(source));
      if (!root || !run || run.motherEligible !== true ||
          canonicalDirectory(wsRoot) !== root || canonicalDirectory(run.workspace) !== root ||
          run.sessionId !== binding.sessionId || !Number.isSafeInteger(run.attempt) || run.attempt < 0 ||
          typeof run.runId !== 'string' || !run.runId ||
          !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
          getEntry(binding.sessionId) !== binding.entry || binding.entry.sm !== binding.sm ||
          binding.entry.gen !== binding.generation || binding.entry.busy !== true ||
          binding.sm?.getSessionId?.() !== binding.sessionId ||
          canonicalDirectory(binding.sm?.getCwd?.()) !== root ||
          synchronous(canAccess(binding.sessionId)) !== true) return null;
      if (binding.runId !== undefined && (run.runId !== binding.runId || run.attempt !== binding.attempt)) return null;
      return run;
    } catch { return null; }
  };
  const bind = (source, {sessionId, entry, generation} = {}) => {
    if (!globalThis.__bindEnterDiag) {
      globalThis.__bindEnterDiag = true;
      try {
        const run = source ? synchronous(resolveExecution(source)) : null;
        if (process.env.YUANSHU_IDENTITY_DIAG === "1") console.log(`[identity] bind 进入：source=${source ? "有" : "无"} run=${run ? "有" : "无"} runEligible=${run?.motherEligible} runSession=${String(run?.sessionId || "").slice(0, 8)} bindSession=${String(sessionId || "").slice(0, 8)} entryMatch=${getEntry(sessionId) === entry} busy=${entry?.busy} gen=${generation} entryGen=${entry?.gen}`);
      } catch {}
    }
    if (!object(source) || consumed.has(source)) return false;
    consumed.add(source);
    const binding = {sessionId, entry, generation, sm: entry?.sm};
    const run = valid(source, binding);
    if (!run) {
      try {
        const r = synchronous(resolveExecution(source));
        const bad = [];
        if (!r) bad.push('resolve');
        if (r && r.motherEligible !== true) bad.push('eligible');
        if (!root) bad.push('root');
        if (safeCanon(wsRoot) !== root) bad.push('wsRoot');
        if (r && safeCanon(r.workspace) !== root) bad.push('runWs');
        if (r && r.sessionId !== binding.sessionId) bad.push('session');
        if (r && !Number.isSafeInteger(r.attempt)) bad.push('attempt');
        if (getEntry(binding.sessionId) !== binding.entry) bad.push('entry');
        if (binding.entry?.sm !== binding.sm) bad.push('sm');
        if (binding.entry?.gen !== binding.generation) bad.push('gen');
        if (binding.entry?.busy !== true) bad.push('busy');
        if (binding.sm?.getSessionId?.() !== binding.sessionId) bad.push('smId');
        if (safeCanon(binding.sm?.getCwd?.()) !== root) bad.push('cwd');
        try { if (canAccess(binding.sessionId) !== true) bad.push('canAccess') } catch { bad.push('canAccess-throw') }
        if (process.env.YUANSHU_IDENTITY_DIAG === "1") console.log('[identity] bind 失败于: ' + (bad.join(',') || '未知'));
      } catch {}
    }
    if (!run) return false;
    bindings.set(source, {...binding, runId: run.runId, attempt: run.attempt});
    return true;
  };
  const resolveMother = (source, context = {}) => {
    if (context.kind !== 'mother' || context.workspace !== workspace) return null;
    const binding = bindings.get(source);
    if (!binding) {
      if (process.env.YUANSHU_IDENTITY_DIAG === "1" && !globalThis.__resolveDiag) { globalThis.__resolveDiag = true; try { console.log(`[identity] resolveMother 无绑定：kind=${context.kind} wsMatch=${context.workspace === workspace} source=${source ? "有" : "无"}`) } catch {} }
      return null;
    }
    if (!valid(source, binding)) { bindings.delete(source); return null; }
    return {actorId: `mother:${workspace}`, originId: `run:${binding.runId}:attempt:${binding.attempt}`};
  };
  return Object.freeze({bind, resolveMother});
}
