// engine/design-research.mjs —— 后台设计调研
//
// 2026-10-19 伙伴：「接入吧」（Lovart 三块里的最后一块）。
// Arti 的做法：接到委托后自己在后台去 Google/Pinterest/Behance 搜，「不占你等待时间」，
// 最后交一份带溯源链接的报告。这里是零 key 版：直接取 Bing 的静态结果页（不需要浏览器），
// 多组查询 → 去重 → 按站点归类 → 存成可回看的报告。
//
// 诚实边界：拿不到 Pinterest/Behance 的内部数据，也没有情绪板图片自动抓取；
// 报告给的是**可点开的来源**，图片要出就交给画布/委托去生成。

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomic-io.mjs';

export const RESEARCH_DIR = path.join('记忆', '运行时', '调研');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_SOURCES = 14;

const nowIso = (now) => new Date(typeof now === 'function' ? now() : (now ?? Date.now())).toISOString();
const slug = (s) => String(s || '').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 40) || 'research';
const idOf = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const decode = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

export function buildQueries(topic) {
  const t = String(topic || '').trim();
  if (!t) return [];
  // 三组足够：本身、参考、趋势。多了只是重复烧请求。
  return [t, `${t} 设计 参考`, `${t} design trend 2026`].slice(0, 3);
}

/** 从 Bing 结果页里抽 {title, url, site, snippet}：不依赖浏览器、零 key。 */
export function parseBingHtml(html, count = 5) {
  const out = [];
  const blocks = String(html || '').split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = a[1];
    if (!/^https?:\/\//i.test(url)) continue;
    let site = '';
    try { site = new URL(url).hostname.replace(/^www\./, '') } catch { continue }
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    out.push({ title: decode(a[2]).slice(0, 120), url, site, snippet: decode(p?.[1] || '').slice(0, 240) });
    if (out.length >= count) break;
  }
  return out;
}

async function fetchBing(query, count = 5, { fetchImpl = fetch } = {}) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&count=${count}`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`bing_http_${res.status}`);
  return parseBingHtml(await res.text(), count);
}

/**
 * 搜索供应商链。Bing 是零 key 兜底，但它对非本地出口经常返回无关结果
 * （本机实测：日本出口下"极简海报 版式"返回的是汉字词典条目），
 * 所以只要配了任一 key 就优先用 API。
 *   BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY
 */
export function searchProviders({ fetchImpl = fetch, env = process.env } = {}) {
  const rows = (items) => (Array.isArray(items) ? items : [])
    .map((it) => {
      const url = String(it.url || it.link || '');
      let site = '';
      try { site = new URL(url).hostname.replace(/^www\./, '') } catch { return null }
      return { title: String(it.title || '').slice(0, 120), url, site, snippet: String(it.snippet || it.content || it.description || '').slice(0, 240) };
    })
    .filter(Boolean);

  const list = [];
  if (env.BOCHA_API_KEY) {
    list.push({ name: 'bocha', run: async (q, n) => {
      const res = await fetchImpl('https://api.bochaai.com/v1/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.BOCHA_API_KEY}` },
        body: JSON.stringify({ query: q, count: n, summary: false }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`bocha_http_${res.status}`);
      const j = await res.json();
      return rows(j?.data?.webPages?.value || j?.webPages?.value || []);
    } });
  }
  if (env.TAVILY_API_KEY) {
    list.push({ name: 'tavily', run: async (q, n) => {
      const res = await fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query: q, max_results: n }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`tavily_http_${res.status}`);
      const j = await res.json();
      return rows(j?.results || []);
    } });
  }
  if (env.SERPER_API_KEY) {
    list.push({ name: 'serper', run: async (q, n) => {
      const res = await fetchImpl('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': env.SERPER_API_KEY },
        body: JSON.stringify({ q, num: n }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`serper_http_${res.status}`);
      const j = await res.json();
      return rows(j?.organic || []);
    } });
  }
  list.push({ name: 'bing', run: (q, n) => fetchBing(q, n, { fetchImpl }) });
  return list;
}

function reportMarkdown(record) {
  const s = record.sources || [];
  const bySite = new Map();
  for (const item of s) {
    if (!bySite.has(item.site)) bySite.set(item.site, []);
    bySite.get(item.site).push(item);
  }
  const lines = [`# 调研：${record.topic}`, '', `- 生成时间：${record.createdAt}`,
    `- 查询：${(record.queries || []).join(' / ')}`, `- 来源：${s.length} 条（已去重）`, ''];
  for (const [site, items] of bySite) {
    lines.push(`## ${site}`);
    for (const it of items) lines.push(`- [${it.title}](${it.url})${it.snippet ? ` — ${it.snippet}` : ''}`);
    lines.push('');
  }
  if (!s.length) lines.push('这次没取到结果（Bing 可能限流），换个说法再试。');
  return lines.join('\n');
}

/** 相关性过滤：标题/摘要里至少要出现查询里的某个词（≥2 字），否则是"拆词"产生的噪声。 */
export function isRelevant(row, query) {
  const tokens = String(query || '').split(/[\s,，、]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
  if (!tokens.length) return true;
  const hay = `${row.title || ''} ${row.snippet || ''}`.toLowerCase();
  return tokens.some((t) => hay.includes(t.toLowerCase()));
}

/** 站点权重：设计类站点优先，百科/问答降权——Bing 原序里它们经常霸榜但参考价值低。 */
const BOOST = /(behance|pinterest|dribbble|awwwards|zcool|uisdc|design|artstation|adobe|canva|figma|muzli)/i;
const DEMOTE = /(baike|wikipedia|zhidao|zhihu\.com\/question|quora\.com)/i;
export function rankSources(list) {
  return [...list].sort((a, b) => {
    const score = (x) => (BOOST.test(x.site) ? 2 : 0) + (DEMOTE.test(x.site) ? -3 : 0) + (x.snippet.length > 60 ? 1 : 0);
    return score(b) - score(a);
  });
}

/**
 * 跑一次调研。injectable fetchImpl 便于测试。
 * @returns {{ok:boolean, record:object}}
 */
export async function runResearch(wsRoot, { topic, count = 5, now = Date.now, fetchImpl = fetch } = {}) {
  const t = String(topic || '').trim().slice(0, 120);
  const createdAt = nowIso(now);
  const record = { id: idOf(), topic: t, createdAt, status: 'running', queries: buildQueries(t), sources: [], error: '' };
  const dir = path.join(wsRoot, RESEARCH_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(t)}-${record.id}.json`);

  try {
    const seen = new Set();
    const providers = searchProviders({ fetchImpl });
    record.provider = providers[0]?.name || 'none';
    for (const q of record.queries) {
      let rows = [];
      // 供应商链：优先用配了 key 的 API；都失败才落到 Bing
      for (const p of providers) {
        try {
          rows = await p.run(q, count);
          if (rows.length) { record.provider = p.name; break }
        } catch { rows = [] }
      }
      for (const r of rows) {
        if (seen.has(r.url) || record.sources.length >= MAX_SOURCES) continue;
        if (!isRelevant(r, q)) continue;
        seen.add(r.url);
        record.sources.push({ ...r, query: q });
      }
    }
    record.status = record.sources.length ? 'done' : 'empty';
    if (record.status === 'empty') {
      record.error = record.provider === 'bing'
        ? '搜索源没返回相关结果（Bing 对当前网络出口返回了无关内容）。可以配 BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY 任一，或换网络出口再试。'
        : `搜索源 ${record.provider} 没有返回相关结果。`;
    }
    record.sources = rankSources(record.sources);
  } catch (e) {
    record.status = 'failed';
    record.error = String(e?.message || e).slice(0, 160);
  }

  record.report = reportMarkdown(record);
  atomicWriteJson(file, record);
  return { ok: record.status === 'done', record };
}

export function listResearch(wsRoot, { limit = 20 } = {}) {
  const dir = path.join(wsRoot, RESEARCH_DIR);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } })
      .filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
  } catch { return [] }
}

export function readResearch(wsRoot, id) {
  return listResearch(wsRoot, { limit: 200 }).find((r) => r.id === String(id || '')) || null;
}

// ── 模型侧工具 ─────────────────────────────────────────────────────
export const RESEARCH_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'design_research',
    description: '后台设计调研：给一个主题，自己去搜公开资料，交一份带溯源链接的报告。适合"开工前先摸清参考与趋势"。run 会阻塞十几秒（三组查询），拿到结果再用 canvas/commission 落地。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['run', 'list', 'read'] },
        topic: { type: 'string', description: '调研主题，例如「双11 美妆主视觉」' },
        id: { type: 'string', description: 'read 用' },
      },
      required: ['action'],
    },
  },
};

export function formatResearch(record) {
  if (!record) return '没有这条调研记录。';
  const head = `调研：${record.topic} · ${record.status} · ${record.sources.length} 条来源`;
  const lines = (record.sources || []).slice(0, 10).map((s) => `- [${s.site}] ${s.title} → ${s.url}`);
  return [head, ...lines].join('\n');
}

export function researchExtraExecutors(wsRoot, deps = {}) {
  const now = deps.now || Date.now;
  return {
    design_research: async (args = {}) => {
      try {
        const action = String(args.action || 'list');
        if (action === 'run') {
          const topic = String(args.topic || '').trim();
          if (!topic) return { text: '先给一个调研主题。', isError: true };
          const { record } = await runResearch(wsRoot, { topic, now });
          return { text: record.status === 'done' ? formatResearch(record) : `调研没跑成：${record.error || record.status}`, isError: record.status !== 'done' };
        }
        if (action === 'read') return { text: formatResearch(readResearch(wsRoot, args.id)), isError: false };
        const items = listResearch(wsRoot, { limit: 10 });
        if (!items.length) return { text: '还没有调研记录。', isError: false };
        return { text: items.map((r) => `${r.createdAt.slice(0, 16)} · ${r.topic}（${r.status}，${r.sources.length} 条）`).join('\n'), isError: false };
      } catch (e) {
        return { text: `调研失败：${String(e?.message || e).slice(0, 120)}`, isError: true };
      }
    },
  };
}
