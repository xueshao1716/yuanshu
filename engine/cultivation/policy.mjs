// engine/cultivation/policy.mjs
const fields = ['enabled', 'maxAgents', 'maxConcurrent', 'dailyRequests',
  'dailyBudgetCents', 'currency', 'allowRemote', 'recursive', 'expiresAt',
  'models', 'tools', 'dataScopes'];
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const list = value => Array.isArray(value) && value.length <= 64 &&
  Array.from(value).every(v => typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v) &&
  new Set(value).size === value.length;

export function defaultPolicy() {
  return {enabled: false, maxAgents: 3, maxConcurrent: 1, dailyRequests: 0,
    dailyBudgetCents: 0, currency: 'USD', allowRemote: false, recursive: false,
    expiresAt: null, models: [], tools: [], dataScopes: [], schedule: null, timeoutMs: 60000};
}

export function validatePolicy(value) {
  const bad = () => { throw new Error('cultivation_invalid_policy'); };
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      fields.some(k => !Object.hasOwn(value, k)) ||
      Object.keys(value).some(k => ![...fields, 'schedule', 'timeoutMs'].includes(k))) bad();
  if (typeof value.enabled !== 'boolean' || typeof value.allowRemote !== 'boolean' ||
      value.recursive !== false || value.currency !== 'USD' ||
      !integer(value.maxAgents, 1, 20) || !integer(value.maxConcurrent, 1, value.maxAgents) ||
      value.maxConcurrent > 4 || !integer(value.dailyRequests, 0, 1000) ||
      !integer(value.dailyBudgetCents, 0, 1000000) ||
      !list(value.models) || !list(value.tools) || !list(value.dataScopes)) bad();
  const expiry = value.expiresAt;
  if (expiry !== null && (typeof expiry !== 'string' || expiry.length > 40 ||
      !Number.isFinite(Date.parse(expiry)))) bad();
  if (value.enabled && expiry === null) bad();
  const schedule = value.schedule ?? null, timeoutMs = value.timeoutMs ?? 60000;
  if (!integer(timeoutMs, 1000, 600000)) bad();
  if (schedule !== null) {
    if (!schedule || Object.keys(schedule).length !== 4 || typeof schedule.timezone !== 'string' ||
        schedule.timezone.length > 80 || !Array.isArray(schedule.days) || !schedule.days.length ||
        schedule.days.some(d => !integer(d, 0, 6)) || new Set(schedule.days).size !== schedule.days.length ||
        !integer(schedule.startMinute, 0, 1439) || !integer(schedule.endMinute, schedule.startMinute + 1, 1440)) bad();
    try {new Intl.DateTimeFormat('en-US', {timeZone: schedule.timezone}).format();} catch {bad();}
  }
  return structuredClone({...value, schedule, timeoutMs});
}

export function assertDispatchWindow(policy, now = Date.now()) {
  const {schedule} = validatePolicy(policy);
  if (!schedule) throw new Error('cultivation_schedule_unconfigured');
  if (!Number.isFinite(now)) throw new Error('cultivation_outside_window');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: schedule.timezone,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})
    .formatToParts(now).map(p => [p.type, p.value]));
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (!schedule.days.includes(day) || minute < schedule.startMinute || minute >= schedule.endMinute)
    throw new Error('cultivation_outside_window');
  return true;
}

// 静态约束而非资源预留；调用方仍须使用共同账本和可信身份。
export function assertRequest(policy, request, now = Date.now()) {
  const p = validatePolicy(policy);
  if (!p.enabled) throw new Error('cultivation_policy_disabled');
  if (!Number.isFinite(now) || Date.parse(p.expiresAt) <= now)
    throw new Error('cultivation_policy_expired');
  if (!request || !p.models.includes(request.model) ||
      !list(request.tools) || request.tools.some(t => !p.tools.includes(t)) ||
      !list(request.dataScopes) || request.dataScopes.some(s => !p.dataScopes.includes(s)) ||
      typeof request.remote !== 'boolean' || request.remote && !p.allowRemote ||
      !integer(request.costUpperBoundCents, 0, p.dailyBudgetCents) || p.dailyRequests === 0)
    throw new Error('cultivation_request_denied');
  return true;
}
