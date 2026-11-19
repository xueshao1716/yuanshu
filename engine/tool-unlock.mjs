// engine/tool-unlock.mjs —— 被工具档收起的工具，按需取回（2026-11-19）
//
// 背景：为省 token，普通聊天会按脑区「工具」权重收起一批重工具（brain-regions.filterToolsByTier）。
// 收起后模型连它们存在都不知道——用户点名「让 Claude Code 去做」，她只能自己写脚本绕路。
// 这里补一条路：被收起的工具只给一行目录，模型觉得用得上就调 request_tool 点名取回，
// 从下一步起本会话一直带着它。
//
// 边界：只改「看得见」，不改「能不能用」。取回的工具照样过动作审核、沙箱和各自的开关；
// 只能取回这一轮本来就在工具表里、只是被收起的——调用方传进来的受限工具表（值班/唤醒）里没有的，取不回。
export const REQUEST_TOOL_NAME = 'request_tool';
const MAX_SESSIONS = 300;
const TTL_MS = 12 * 3600_000;

export const REQUEST_TOOL = {
  type: 'function',
  function: {
    name: REQUEST_TOOL_NAME,
    description: '取回被收起的工具。系统提示里【收起的工具】列出了名字和用途；这一轮要用其中某个时，先调本工具点名，下一步它就出现在工具表里（本会话一直保留）。不要为了"以防万一"取回。',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: '要取回的工具名，最多 5 个' },
        reason: { type: 'string', description: '一句话：这一轮为什么要用它' },
      },
      required: ['names'],
    },
  },
};

// key（会话或 run）→ { offered:Set, unlocked:Set, at }
const state = new Map();

function slot(key) {
  let s = state.get(key);
  if (!s) {
    s = { offered: new Set(), unlocked: new Set(), at: Date.now() };
    state.set(key, s);
    if (state.size > MAX_SESSIONS) {
      const cutoff = Date.now() - TTL_MS;
      for (const [k, v] of state) if (v.at < cutoff || state.size > MAX_SESSIONS) state.delete(k);
    }
  }
  s.at = Date.now();
  return s;
}

const nameOf = (t) => t?.function?.name || t?.name || '';
const firstSentence = (d) => String(d || '').split(/[。\n]/)[0].slice(0, 60);

/**
 * 组装这一步真正下发的工具表。
 * @param {object[]} all     本轮原始工具表（调用方已按场景限定过）
 * @param {object[]} kept    按工具档过滤后的
 * @param {string}   key     会话 id（没有就用 runId）；为空则不提供取回
 * @returns {{ tools: object[], catalog: string }}
 */
export function composeTools(all, kept, key) {
  if (!Array.isArray(all) || !Array.isArray(kept) || !key) return { tools: kept, catalog: '' };
  const keptNames = new Set(kept.map(nameOf));
  const hidden = all.filter((t) => { const n = nameOf(t); return n && !keptNames.has(n) && n !== REQUEST_TOOL_NAME });
  if (!hidden.length) return { tools: kept, catalog: '' };
  const s = slot(key);
  s.offered = new Set(hidden.map(nameOf));
  const back = hidden.filter((t) => s.unlocked.has(nameOf(t)));
  const still = hidden.filter((t) => !s.unlocked.has(nameOf(t)));
  const tools = [...kept, ...back];
  if (!still.length) return { tools, catalog: '' };
  tools.push(REQUEST_TOOL);
  // MCP / 工具包类数量大，只报个数，免得目录本身又变成一大段
  const named = still.filter((t) => !/^(mcp_|tp_)/.test(nameOf(t)));
  const bulk = still.length - named.length;
  const lines = named.map((t) => `${nameOf(t)}：${firstSentence(t.function?.description || t.description)}`);
  const catalog = `【收起的工具】下面这些这轮没放进工具表，要用就先调 request_tool 点名取回：\n${lines.join('\n')}${bulk ? `\n（另有 ${bulk} 个 MCP/工具包工具，名字以 mcp_ / tp_ 开头）` : ''}`;
  return { tools, catalog };
}

/** request_tool 执行器。ctx 里带 sessionId / runId（unified-chat 的 executionContext）。 */
export function requestToolExec(args = {}, ctx = {}) {
  const key = String(ctx?.sessionId || ctx?.runId || '');
  if (!key) return { text: '这一轮没有会话，取不回工具', isError: true };
  const s = state.get(key);
  const want = (Array.isArray(args.names) ? args.names : [args.names]).map((n) => String(n || '').trim()).filter(Boolean).slice(0, 5);
  if (!want.length) return { text: '请在 names 里写要取回的工具名', isError: true };
  const ok = [], bad = [];
  for (const n of want) (s?.offered.has(n) ? ok : bad).push(n);
  if (s) { for (const n of ok) s.unlocked.add(n); s.at = Date.now(); }
  if (!ok.length) return { text: `这些不在收起的工具里：${bad.join('、')}。只能取回【收起的工具】列出的`, isError: true };
  return {
    text: `已取回：${ok.join('、')}，下一步就能直接调用（本会话保留）。${bad.length ? `没找到：${bad.join('、')}。` : ''}权限、开关和次数限制不变。`,
    isError: false,
  };
}

export function unlockedFor(key) { return [...(state.get(String(key || ''))?.unlocked || [])]; }
export function _resetToolUnlock() { state.clear(); }
