import fs from 'node:fs'
import path from 'node:path'

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(id)
const key = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value)
const samePath = (a, b) => key(a) === key(b)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function absolute(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\x00-\x1f]/.test(value)
      || !path.isAbsolute(value) || !samePath(path.resolve(value), value)) return false
  const root = path.parse(value).root
  if (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^?\\]+\\[^\\]+\\)$/i.test(root)) return false
  return value.slice(root.length).split(/[\\/]/).every(part => part !== '.' && part !== '..'
    && part.toLowerCase() !== '.trash' && (process.platform !== 'win32' || !/[<>:"|?*]|[. ]$/.test(part)))
}

// Check every ancestor, including parents above the configured sessions root.
// realpath alone would silently follow a junction and turn a foreign root trusted.
function directory(value) {
  if (!absolute(value)) return false
  let current = path.parse(value).root
  for (const part of ['', ...value.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
  }
  return samePath(fs.realpathSync(value), value)
}

function validRows(rows, id, cwd) {
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !object(row))) return false
  const header = rows[0]
  return header.type === 'session' && validId(header.id) && header.id === id
    && absolute(header.cwd) && samePath(header.cwd, cwd) && directory(header.cwd)
    && (header.version === undefined || [1, 2, 3].includes(header.version))
    && typeof header.timestamp === 'string' && Number.isFinite(Date.parse(header.timestamp))
    && !rows.slice(1).some(row => row.type === 'session')
    && !rows.some(row => row.customType === 'voice-task-origin')
}

const regular = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && regular(b)

function readPersisted(file, before) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    if (!unchanged(before, fs.fstatSync(fd)) || !samePath(fs.realpathSync(file), file)) return null
    const rows = fs.readFileSync(fd, 'utf8').split('\n').filter(line => line.trim()).map(JSON.parse)
    if (!unchanged(before, fs.fstatSync(fd)) || !unchanged(before, fs.lstatSync(file))) return null
    return rows
  } finally { fs.closeSync(fd) }
}

// The host supplies the private proof for lazy managers, never an HTTP caller.
// This validator performs synchronous reads only; it never invokes SDK open/create.
export function validateSessionOrigin({ id, file, sessionsDir, cwd, sm = null, allowUnpersisted = false }) {
  try {
    if (!validId(id) || !absolute(file) || !directory(sessionsDir) || !directory(cwd)
        || !samePath(path.dirname(file), sessionsDir) || path.extname(file) !== '.jsonl') return false
    if (sm && (sm.getSessionId?.() !== id || !absolute(sm.getSessionFile?.())
        || !samePath(sm.getSessionFile(), file) || !absolute(sm.getCwd?.()) || !samePath(sm.getCwd(), cwd))) return false
    let stat
    try { stat = fs.lstatSync(file) }
    catch (error) { if (error.code !== 'ENOENT') return false }
    if (stat) return regular(stat) && validRows(readPersisted(file, stat), id, cwd)
    if (!allowUnpersisted || !sm || sm.flushed === true) return false
    // SDK fileEntries includes the header and custom markers; getEntries alone does not.
    const rows = Array.isArray(sm.fileEntries) ? sm.fileEntries : sm.getFileEntries?.()
    if (!validRows(rows, id, cwd)) return false
    return typeof sm.getHeader !== 'function' || validRows([sm.getHeader(), ...rows.slice(1)], id, cwd)
  } catch { return false }
}

// Reuse the same disk/path integrity checks for workers without relaxing the
// origin validator: a worker can never qualify as a user conversation.
export function validateVoiceTaskSession(task, { sessionsDir, cwd }) {
  try {
    if (!validId(task.sessionId) || task.sessionId === task.conversationId || !task.id || !task.conversationId
        || !directory(sessionsDir) || !directory(cwd)) return false
    const file = path.join(sessionsDir, task.sessionId + '.jsonl'), stat = fs.lstatSync(file)
    if (!regular(stat)) return false
    const rows = readPersisted(file, stat)
    if (!Array.isArray(rows)) return false
    const owners = rows.filter(row => row?.customType === 'voice-task-origin')
    return owners.length === 1 && owners[0].type === 'custom' && owners[0].data?.taskId === task.id
      && owners[0].data?.conversationId === task.conversationId
      && validRows(rows.filter(row => row !== owners[0]), task.sessionId, cwd)
  } catch { return false }
}
