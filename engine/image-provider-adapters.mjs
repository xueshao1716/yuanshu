// Provider-specific image protocols shared by chat, stories and workshops.
import { setTimeout as delay } from 'node:timers/promises';
import { httpJsonFetch, httpBufferFetch } from './http.mjs';
import { observeMediaRequest, recordMediaFailure, readMediaJson } from './media-observations.mjs';

export function imageProviderSize(provider, modelId, size = '1024x1024') {
  if (provider !== 'volces-ark' || !/seedream/i.test(modelId)) return size;
  return { '1024x1024': '1920x1920', '832x1472': '1440x2560', '736x1312': '1440x2560',
    '720x1280': '1440x2560', '1472x832': '2560x1440' }[size] || size;
}

export async function generateProviderImage({ provider, modelId, prompt, size, image, seed, negative,
  baseUrl, key, accountId, signal, onRequest }) {
  const special = ['minimax', 'modelscope', 'cloudflare-ai'].includes(provider)
    || (provider === 'aliyun-bailian' && /^wan\d/.test(modelId));
  if (!special) return null;
  signal?.throwIfAborted();
  // Do not silently discard a reference when this adapter has no reference protocol.
  if (image && ['minimax', 'cloudflare-ai'].includes(provider)) throw new Error(`${provider} 当前绘图适配器不支持参考图，请选择支持图生图的模型`);
  const base = (baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  const observation = {kind:'image',provider,model:modelId,signal};
  let attempt = 0;
  const post = async (url, body, extra = {}) => {
    signal?.throwIfAborted();
    try {
      const observed = onRequest?.({ source: 'host_http_dispatch', model: modelId, size,
        endpointPath: new URL(url).pathname.replace(/\/accounts\/[^/]+/, '/accounts/[configured]'), attempt: ++attempt });
      observed?.catch?.(() => {});
    } catch { /* Observability must not trigger another purchase. */ }
    return observeMediaRequest(observation, () => httpJsonFetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), timeout: 180000, signal }));
  };
  const decode = async r => {
    if (!r.ok) throw Object.assign(new Error(`${provider} 绘图失败 ${r.status}: ${(await r.text()).slice(0, 600)}`), { status: r.status });
    return readMediaJson(observation,r);
  };
  const requireImage = value => {
    if (typeof value !== 'string' || !value) {recordMediaFailure(observation,{code:'invalid_response'});throw new Error(`${provider} 绘图接口未返回图片`);}
    return value;
  };
  const params = { ...(seed != null ? { seed } : {}), ...(negative ? { negative_prompt: negative } : {}) };
  if (provider === 'aliyun-bailian') {
    const sizeMap = { '1024x1024': '1024*1024', '832x1472': '720*1280', '736x1312': '720*1280', '720x1280': '720*1280', '1920x1920': '1024*1024' };
    const host = (baseUrl || '').includes('maas.aliyuncs.com') ? baseUrl.replace(/\/compatible-mode\/v1.*$/, '') : '';
    const apiBase = host || 'https://token-plan.cn-beijing.maas.aliyuncs.com';
    const data = await decode(await post(`${apiBase}/api/v1/services/aigc/multimodal-generation/generation`, {
      model: modelId, input: { messages: [{ role: 'user', content: [...(image ? [{ image }] : []), { text: prompt }] }] },
      parameters: { size: sizeMap[size] || '1024*1024', n: 1, ...params },
    }));
    return requireImage(data?.output?.choices?.[0]?.message?.content?.find?.(c => c?.image)?.image);
  }
  if (provider === 'minimax') {
    const ratioMap = { '1024x1024': '1:1', '832x1472': '9:16', '1472x832': '16:9', '1024x1792': '9:16', '1792x1024': '16:9' };
    const body = { model: modelId, prompt, aspect_ratio: ratioMap[size] || '9:16', response_format: 'url', ...params };
    let r = await post(`${base}/v1/image_generation`, body);
    if ([404, 405, 501].includes(r.status)) r = await post(`${base}/image_generation`, body);
    const data = await decode(r);
    return requireImage(data?.data?.image_urls?.[0]);
  }
  if (provider === 'modelscope') {
    const sizeMap = { '832x1472': '720x1280', '736x1312': '720x1280', '1920x1920': '1024x1024' };
    const created = await decode(await post(`${base}/v1/images/generations`, {
      model: modelId, prompt, n: 1, size: sizeMap[size] || size, ...(image ? { image } : {}), ...params,
    }, { 'X-ModelScope-Async-Mode': 'true' }));
    if (!created.task_id) {recordMediaFailure(observation,{code:'invalid_response'});throw new Error('modelscope 未返回 task_id');}
    for (let i = 0; i < 18; i++) {
      await delay(5000, undefined, { signal });
      const r = await observeMediaRequest({...observation,phase:'poll'}, () => httpJsonFetch(`${base}/v1/tasks/${encodeURIComponent(created.task_id)}`, {
        headers: { Authorization: `Bearer ${key}`, 'X-ModelScope-Task-Type': 'image_generation' }, timeout: 30000, signal,
      }));
      if (!r.ok) continue;
      const data = await readMediaJson({...observation,phase:'poll'},r);
      if (data.task_status === 'SUCCEED') return requireImage(data.output_images?.[0]);
      if (data.task_status === 'FAILED') {recordMediaFailure({...observation,phase:'poll'},{code:'generation_failed'});throw new Error(`modelscope 任务失败: ${String(data.message || '未知').slice(0, 200)}`);}
    }
    throw new Error(`modelscope 任务超时（90s，任务号 ${created.task_id}）；请查询原任务，不要重复提交`);
  }
  if (!accountId) throw new Error('cloudflare-ai 未配置 account_id（模型管理中添加）');
  const sizeMap = { '1024x1024': [512, 512], '832x1472': [512, 896], '736x1312': [512, 896], '720x1280': [512, 896], '1920x1920': [768, 768] };
  const [width, height] = sizeMap[size] || [512, 512];
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`;
  const multipart = /flux-2/.test(modelId);
  if (/leonardo\/phoenix/.test(modelId) || multipart) {
    const boundary = `----yuanshu${Math.floor(Math.random() * 1e9)}`;
    const body = multipart ? `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n--${boundary}--\r\n`
      : JSON.stringify({ prompt, width, height, steps: 4, ...params });
    const r = await observeMediaRequest(observation, () => httpBufferFetch(url, { method: 'POST', headers: { ...headers,
      ...(multipart ? { 'Content-Type': `multipart/form-data; boundary=${boundary}` } : {}) }, body, timeout: 180000, signal }));
    if (r.status >= 300) throw Object.assign(new Error(`cloudflare 绘图失败 ${r.status}`), { status: r.status });
    const buf = r.buffer();
    if (!buf?.length) throw new Error('cloudflare 未返回图片数据');
    let data;
    try { data = JSON.parse(buf.toString('utf8')); } catch { return `data:image/jpeg;base64,${buf.toString('base64')}`; }
    return `data:image/jpeg;base64,${requireImage(data?.result?.image)}`;
  }
  const data = await decode(await post(url, { prompt, width, height, steps: 4, ...params }));
  return `data:image/jpeg;base64,${requireImage(data?.result?.image)}`;
}
