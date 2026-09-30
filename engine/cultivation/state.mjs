// engine/cultivation/state.mjs
export const MAX_AUDIT = 256;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fields = ['schema', 'workspace', 'scope', 'revision', 'createdAt', 'updatedAt', 'data', 'audit'];
const own = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const iso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const label = v => typeof v === 'string' && v.length > 0 && v.length <= 200 &&
  !/[\x00-\x1f]/.test(v);
const fail = code => { throw new Error(`cultivation_${code}`); };

export const validScope = scope => scope === 'control' || typeof scope === 'string' && uuid.test(scope);

function jsonProperty(value, key, depth) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid_payload');
  jsonValue(descriptor.value, depth + 1);
}

function jsonValue(value, depth = 0) {
  if (depth > 12) fail('invalid_payload');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string' && value.length <= 32768) return;
  if (Array.isArray(value) && value.length <= 256) {
    if (Reflect.ownKeys(value).length !== value.length + 1) fail('invalid_payload');
    for (let i = 0; i < value.length; i++) jsonProperty(value, String(i), depth);
    return;
  }
  if (own(value) && Reflect.ownKeys(value).length <= 256) {
    for (const key of Reflect.ownKeys(value)) {
      if (!label(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('invalid_payload');
      jsonProperty(value, key, depth);
    }
    return;
  }
  fail('invalid_payload');
}

export function emptyRecord(workspace, scope) {
  const row = {schema: 1, workspace, scope, revision: 0,
    createdAt: null, updatedAt: null, data: {}, audit: []};
  return validateRecord(row, workspace, scope);
}

export function validateRecord(row, workspace, scope) {
  if (!/^[0-9a-f]{64}$/.test(workspace) || !validScope(scope) || !own(row) ||
      Object.keys(row).length !== fields.length || fields.some(k => !Object.hasOwn(row, k)) ||
      row.schema !== 1 || row.workspace !== workspace || row.scope !== scope ||
      !Number.isSafeInteger(row.revision) || row.revision < 0 || !own(row.data) ||
      !Array.isArray(row.audit) || row.audit.length > MAX_AUDIT || row.audit.length !== row.revision)
    fail('invalid_record');
  jsonValue(row.data);
  if (row.revision === 0) {
    if (row.createdAt !== null || row.updatedAt !== null || Object.keys(row.data).length) fail('invalid_record');
  } else if (!iso(row.createdAt) || !iso(row.updatedAt)) fail('invalid_record');
  for (const [index, item] of row.audit.entries()) {
    if (!own(item) || Object.keys(item).length !== 4 || item.revision !== index + 1 ||
        !label(item.actor) || !label(item.action) || !iso(item.at) ||
        index > 0 && Date.parse(item.at) < Date.parse(row.audit[index - 1].at)) fail('invalid_record');
  }
  if (row.revision && (row.createdAt !== row.audit[0].at ||
      row.updatedAt !== row.audit.at(-1).at)) fail('invalid_record');
  return structuredClone(row);
}

export function advanceRecord(previous, data, event) {
  const row = validateRecord(previous, previous.workspace, previous.scope);
  if (row.audit.length >= MAX_AUDIT) fail('audit_full');
  if (!event || !label(event.actor) || !label(event.action) || !iso(event.at)) fail('invalid_record');
  if (!own(data)) fail('invalid_payload');
  jsonValue(data);
  const at = row.updatedAt && Date.parse(row.updatedAt) > Date.parse(event.at) ? row.updatedAt : event.at;
  row.revision++;
  row.createdAt ??= at;
  row.updatedAt = at;
  row.data = structuredClone(data);
  row.audit.push({revision: row.revision, actor: event.actor, action: event.action, at});
  return validateRecord(row, previous.workspace, previous.scope);
}
