import { modelCapabilities } from './model-probe.mjs';

export function imageCandidates(models, intent = {}, prompt = '') {
  let hits = models.filter(m => m.enabled !== false && (m.capabilities || modelCapabilities(m.id)).image);
  const provider = String(intent.provider || '').trim();
  const modelId = String(intent.modelId || '').trim();
  let explicit = !!(provider || modelId);
  if (explicit) {
    hits = hits.filter(m => (!provider || m.provider === provider) && (!modelId || m.id === modelId));
  } else {
    // Only an instruction prefix selects a family; descriptive/quoted prompt content is not a selector.
    const prefix = String(prompt).trim();
    const named = hits.filter(m => prefix.startsWith(`用 ${m.id} `) || prefix.startsWith(`用${m.id}画`) || prefix.startsWith(`使用 ${m.id} `));
    if (named.length) { hits = named; explicit = true; }
    else if (/^(?:请)?(?:用|使用)\s*(?:OpenAI|GPT[- ]?Image)(?=\s|画|绘|生|出)/i.test(prefix)) {
      hits = hits.filter(m => /^gpt-image-/i.test(m.id)); explicit = true;
    }
  }
  if (!hits.length) throw new Error(explicit ? '指定的绘图模型未配置或不存在，请用 list_channels 核对 provider / modelId' : '未配置可用绘图模型');
  const rank = m => /2\.5|3\.|latest|pro/.test(m.id) ? 0 : /2\.0/.test(m.id) ? 2 : 1;
  hits.sort((a, b) => rank(a) - rank(b));
  // Explicit selection must never silently become another model. Auto retries at most one other provider.
  const first = hits[0];
  const backup = !explicit && hits.find(m => m.provider !== first.provider && !/-edit(?:-|$)/i.test(m.id));
  return backup ? [first, backup] : [first];
}

export async function runImageCandidates(candidates, generate) {
  const attempts = [];
  for (const m of candidates) {
    const model = `${m.provider}/${m.id}`;
    try {
      const url = await generate(m);
      if (!url) throw new Error('图像模型未返回图片');
      attempts.push({ model, outcome: 'succeeded' });
      return { url, model, attempts };
    } catch (e) {
      attempts.push({ model, outcome: 'failed', ...(e.status ? { status: e.status } : {}) });
      // Do not retry policy/parameter errors, ambiguous timeouts or malformed successful responses.
      if (![429, 502, 503, 504].includes(e.status) || attempts.length === candidates.length) {
        return { error: String(e.message || e), model, attempts };
      }
    }
  }
}
