// 会话侧栏分段（2026-10-06）：纯函数，前端与单测共用。
// 规则：置顶单列；对话按「今天 / 昨天 / 7 天内 / 30 天内 / 更早」分段；
// 微信、终端、真测各成一组。组内按更新时间倒序（列表接口已排好，这里保持原序）。

export const SESSION_GROUPS = [
  { key: 'workspace', label: '对话' },
  { key: 'wechat', label: '微信' },
  { key: 'terminal', label: '终端' },
  { key: 'test', label: '真测' },
]

export const TIME_BUCKETS = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'week', label: '7 天内' },
  { key: 'month', label: '30 天内' },
  { key: 'older', label: '更早' },
]

// 默认收起：更早的对话、终端、真测。打开过的状态记在 localStorage。
export const DEFAULT_COLLAPSED = ['workspace:older', 'terminal', 'test']

const DAY = 86400000

export function timeBucketOf(iso, now = Date.now()) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return 'older'
  const d = new Date(now)
  const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (t >= startToday) return 'today'
  if (t >= startToday - DAY) return 'yesterday'
  if (t >= startToday - 6 * DAY) return 'week'
  if (t >= startToday - 29 * DAY) return 'month'
  return 'older'
}

// 微信桥会话名是「微信·<掩码id>」，组名已经说明来源，行里只留短 id。
export function displayName(s) {
  const name = String(s?.name || '').trim()
  if (s?.group === 'wechat') {
    const rest = name.replace(/^微信[·・]\s*/, '')
    return rest ? `联系人 ${rest.slice(0, 8)}` : '微信联系人'
  }
  return name || '新会话'
}

export function matchesSearch(s, kw) {
  const k = String(kw || '').trim().toLowerCase()
  if (!k) return true
  return [s?.name, s?.preview, displayName(s)].some(v => String(v || '').toLowerCase().includes(k))
}

// 返回 [{ key, label, count, buckets?: [{ key, label, items }], items? }]
export function planSidebar(sessions, { now = Date.now(), search = '' } = {}) {
  const list = (sessions || []).filter(s => matchesSearch(s, search))
  const out = []
  const pinned = list.filter(s => s.pinned)
  if (pinned.length) out.push({ key: 'pinned', label: '置顶', count: pinned.length, items: pinned })
  const rest = list.filter(s => !s.pinned)
  for (const g of SESSION_GROUPS) {
    const items = rest.filter(s => (s.group || 'workspace') === g.key)
    if (!items.length) continue
    if (g.key !== 'workspace') { out.push({ key: g.key, label: g.label, count: items.length, items }); continue }
    const buckets = TIME_BUCKETS
      .map(b => ({ key: b.key, label: b.label, items: items.filter(s => timeBucketOf(s.updatedAt || s.createdAt, now) === b.key) }))
      .filter(b => b.items.length)
    out.push({ key: g.key, label: g.label, count: items.length, buckets })
  }
  return out
}
