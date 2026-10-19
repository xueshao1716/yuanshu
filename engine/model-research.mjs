// engine/model-research.mjs —— 借模型自带的联网搜索做调研
//
// 2026-10-19 伙伴：「deepseek 不是可以搜索吗」。
// 事实是：元枢里的 web_search 工具也是抓 Bing 静态页——同一个出口，同样的噪声。
// 但**模型侧的联网搜索**（智谱 glm-4.5 的 web_search 工具）在厂商服务器上跑，不吃我们的出口，
// 它给出的链接是真的（实测有 zcool.com.cn 这类结果）；代价是它偶尔会编链接。
//
// 所以这条路的关键不是"信模型"，而是：**模型给候选，我们逐条验活**。
// 验不过的链接直接丢掉，报告里只留真能打开的来源。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function buildResearchPrompt(topic) {
  return [
    `请联网搜索「${topic}」相关的设计参考资料（案例、趋势、版式、情绪板）。`,
    '只返回 JSON 数组，不要任何解释文字。格式：',
    '[{"title":"标题","url":"https://...","snippet":"一句话摘要"}]',
    '要求：',
    '1) 3-6 条；2) url 必须真实可打开，禁止编造或用 example.com；',
    '3) 优先具体案例/文章页；确实找不到具体页时，可以给 Behance/Pinterest/站酷/优设/Dribbble 的**检索入口页**，但不要伪造文章地址；',
    '4) snippet 不超过 80 字，写清这条为什么值得看（风格、版式、趋势）；5) 中文主题用中文，英文主题用英文。',
  ].join('\n');
}

/** 从模型回复里抽 JSON 数组（容忍 ```json 围栏和前后废话）。 */
export function extractJsonRows(text) {
  const raw = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x === 'object' && typeof x.url === 'string')
      .map((x) => ({
        title: String(x.title || '').slice(0, 120),
        url: String(x.url).trim(),
        snippet: String(x.snippet || x.description || '').slice(0, 240),
      }))
      .filter((x) => /^https?:\/\//i.test(x.url));
  } catch { return [] }
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } };

/** 逐条验活：打开不了的、不是网页的，一律丢掉。这是"不信模型"的那道闸。 */
export async function verifySources(rows, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const site = hostOf(row.url);
    if (!site || seen.has(row.url)) continue;
    try {
      const res = await fetchImpl(row.url, {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const type = String(res.headers?.get?.('content-type') || '');
      if (!res.ok) continue;
      if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) continue;
      seen.add(row.url);
      out.push({ ...row, site, verified: true });
    } catch { /* 打不开就当它不存在 */ }
  }
  return out;
}

/**
 * 让模型联网搜一轮，再逐条验活。
 * @returns {{rows: Array, model: string, raw: string}}
 */
export async function modelSearchRows({ topic, model, baseUrl, key, count = 6, timeoutMs = 120000 }, { fetchImpl = fetch, verify = true } = {}) {
  if (!baseUrl || !key) return { rows: [], model, raw: '' };
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildResearchPrompt(topic) }],
      tools: [{ type: 'web_search', web_search: { enable: true, search_query: topic } }],
      temperature: 0.3,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`model_http_${res.status}`);
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content || '';
  const candidates = extractJsonRows(text).slice(0, count);
  const rows = verify ? await verifySources(candidates, { fetchImpl }) : candidates.map((r) => ({ ...r, site: hostOf(r.url), verified: false }));
  return { rows, model: String(j?.model || model), raw: text };
}
