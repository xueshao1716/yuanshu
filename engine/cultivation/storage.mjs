// engine/cultivation/storage.mjs
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {withFileLock} from '../file-lock.mjs';
import {reviewStoragePath, reviewAtomicWrite} from '../review-file-safety.mjs';
import {readReviewBounded} from '../review-read.mjs';
import {emptyRecord, validateRecord, advanceRecord, validScope, clonePayload} from './state.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
export function createCultivationStorage({wsRoot, now = () => new Date().toISOString(),
  atomicWrite = reviewAtomicWrite}) {
  if (typeof wsRoot !== 'string' || fs.lstatSync(wsRoot).isSymbolicLink())
    throw new Error('cultivation_path_denied');
  const root = fs.realpathSync(wsRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('cultivation_path_denied');
  const canonical = process.platform === 'win32' ? root.toLowerCase() : root;
  const workspace = createHash('sha256').update(canonical).digest('hex');
  const location = scope => {
    if (!validScope(scope)) throw new Error('cultivation_invalid_scope');
    const relative = scope === 'control' ? 'control.json' : `agents/${scope}/state.json`;
    return reviewStoragePath(root, `工程/智能体培养/${relative}`);
  };
  const read = scope => {
    const file = location(scope);
    let data;
    try { data = JSON.parse(readReviewBounded(file, MAX_BYTES).toString('utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return emptyRecord(workspace, scope);
      throw new Error('cultivation_state_unreadable', {cause: error});
    }
    return validateRecord(data, workspace, scope);
  };
  const version = scope => {
    try {
      const stat = fs.statSync(location(scope), {bigint: true});
      if (!stat.isFile() || stat.size > BigInt(MAX_BYTES)) throw new Error('cultivation_state_unreadable');
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {if (error.code === 'ENOENT') return null; throw error;}
  };
  const commit = async (scope, command, {guard = () => true} = {}) => {
    // 在等待锁之前快照命令，调用者后续改对象不改变本次请求。
    const input = command && {expectedRevision: command.expectedRevision,
      actor: command.actor, action: command.action};
    if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      throw new Error('cultivation_revision_conflict');
    input.data = clonePayload(command.data);
    return withFileLock(location(scope), () => {
      const previous = read(scope);
      if (previous.revision !== input.expectedRevision) throw new Error('cultivation_revision_conflict');
      const allowed = guard(structuredClone(previous));
      if (allowed instanceof Promise) allowed.catch(() => {});
      if (allowed !== true) throw new Error('cultivation_guard_denied');
      const next = advanceRecord(previous, input.data,
        {actor: input.actor, action: input.action, at: now()});
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('cultivation_storage_full');
      // 持锁后再次检查链接边界；原子写失败不得返回已提交。
      atomicWrite(location(scope), text);
      return structuredClone(next);
    });
  };
  return Object.freeze({workspace, read, version, commit});
}
