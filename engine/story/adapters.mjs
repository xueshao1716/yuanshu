function cleanModel(model) { return { provider: String(model?.provider || ''), id: String(model?.id || '') }; }

// saveArtifact 的正式返回是 { url, local, reason }（见 docs/NAMING.md 产物本地化契约）。
// 注入实现（测试替身、外部接入）可能仍返回字符串，这里统一成对象形状，
// 免得适配器里到处判断类型。
function normalizeStored(result, fallbackUrl) {
  if (typeof result === 'string') return { url: result, local: true, reason: '' };
  if (result && typeof result === 'object' && typeof result.url === 'string') {
    return { url: result.url, local: result.local !== false, reason: String(result.reason || '') };
  }
  return { url: String(fallbackUrl || ''), local: false, reason: '落盘实现未返回结果' };
}

// 上游把参考图摘掉时（media-inline 落不下来，见 engine/media-inline.mjs），
// 这一趟就是"没带参考图"的片子。适配器如实上报，编排层把它并进 run.degradation，
// 于是任务显示「已生成 · 请核对连续性」而不是一个看不出问题的"成功"。
function adapterNotes(result) {
  return Array.isArray(result?.notes) ? result.notes.filter(Boolean).map(String) : [];
}

export function createImageAdapter({ generateImage, saveArtifact }) {
  return {
    async generate({ prompt, model, seed, params = {}, references = [], referenceImages = [] } = {}) {
      if (typeof generateImage !== 'function') return { status: 'failed', error: '图像引擎未接入' };
      // 真参考图：把首张定妆照当作 image 传给上游（图生图），而不是只把 id 拼进提示词。
      // 没有参考图时提示词里显式说明，让"人物一致性有限"这件事在产物里也留痕。
      const ref = Array.isArray(referenceImages) ? String(referenceImages.find(Boolean) || '') : '';
      const marker = [
        Number.isFinite(seed) ? `seed=${seed}` : '',
        references.length ? `references=${references.join(',')}` : '',
        ref ? '已附角色定妆照参考图（图生图锁定）' : '无参考图，仅文字描述，人物一致性有限',
      ].filter(Boolean).join('；');
      const finalPrompt = marker ? `${String(prompt || '').trim()}\n[连续性参数] ${marker}` : String(prompt || '').trim();
      try {
        // seed 真的上送（2026-09-15 修）：此前它只被拼进提示词文本，模型不认，
        // 而能力声明却写着"支持固定 seed"——声称支持却从未生效。
        const url = await generateImage(model?.provider, model?.id, finalPrompt, params.size, ref || undefined, { seed, negative: params.negative });
        if (!url) return { status: 'failed', error: '图像模型未返回图片', model: cleanModel(model) };
        const stored = typeof saveArtifact === 'function' ? normalizeStored(await saveArtifact({ type: 'image', url, prompt: finalPrompt }), url) : { url, local: true, reason: '' };
        return { status: 'succeeded', model: cleanModel(model), output: { type: 'image', url: stored.url || url, prompt: finalPrompt, ...(stored.local ? {} : { localizeError: stored.reason }) } };
      } catch (error) { return { status: 'failed', error: String(error?.message || error).slice(0, 200), model: cleanModel(model) }; }
    },
  };
}

export function createNovelAdapter({ directChat }) {
  return {
    async generate({ prompt, model, history = [], params = {} } = {}) {
      if (typeof directChat !== 'function') return { status: 'failed', error: '小说引擎未接入' };
      try {
        const result = await directChat(model, prompt, history, { maxTokens: params.maxTokens || 6000, timeout: params.timeout || 180000 });
        const text = String(result?.text || '').trim();
        if (!text) return { status: 'failed', error: '小说模型未返回正文', model: cleanModel(model) };
        return { status: 'succeeded', model: cleanModel(model), output: { type: 'text', text } };
      } catch (error) { return { status: 'failed', error: String(error?.message || error).slice(0, 200), model: cleanModel(model) }; }
    },
  };
}

// 上游"忙"和上游"拒绝"是两件事，处理方式也该是两回事。
// 2026-09-16 真机批量撞到：`video_queue_full 503 — video queue is full, please retry later`。
// 这句是上游自己让我们稍后再试的，而当时的实现把它当成终局失败直接报给用户——
// 用户看到的是"失败"，实际上只是那一秒队列满了。
// 照 Lovart 的公开约定：网络/瞬时错误自动重试并退避，**限流与计费错误直接返回**（重试也白搭）。
const TRANSIENT_RE = /queue is full|queue_full|please retry|too many requests|rate ?limit|\b(429|500|502|503|504)\b|timeout|timed out|ECONNRESET|socket hang up|fetch failed/i;
const FATAL_RE = /insufficient|balance|quota|unauthor|forbidden|invalid|not ?found|billing|payment/i;
const RETRY_DELAYS = [2000, 5000];   // 两次重试，最多多等 7 秒——再久就该让用户自己决定
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 只对"创建"这一步重试：它是幂等语义最清楚的一步（要么拿到任务号，要么没拿到）。
// 收尾查询不重试——查一次就是查一次，等多久由人/轮询决定。
async function startWithRetry(run, label, delays = RETRY_DELAYS) {
  let last = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const r = await run();
      const text = `${r?.error || ''}`;
      if (r?.task_id || r?.video) return r;
      if (!text || FATAL_RE.test(text) || !TRANSIENT_RE.test(text)) return r;
      last = r;
    } catch (error) {
      const text = String(error?.message || error);
      if (FATAL_RE.test(text) || !TRANSIENT_RE.test(text)) throw error;
      last = { error: text };
    }
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  return { ...(last || {}), error: `${label}（上游忙，已重试 ${delays.length} 次）：${last?.error || '未知原因'}` };
}

export function createVideoAdapter({ generateVideo, startVideoJob, checkVideoJob, saveArtifact, retryDelays = RETRY_DELAYS }) {
  // 提示词与创建体只在这里组一遍：同步路径（generate）与"只创建"路径（start）必须完全一致，
  // 否则两条路会各自漂移——那种不一致很难被发现，只会在某一条路上出结果。
  const build = ({ prompt, model, seed, params = {}, references = [], referenceImages = [] } = {}) => {
    // 真参考图：把角色定妆照作为 images[] 传给上游，videoCreateBody 见到 images 会自动
    // 把 mode 落成 "reference"（见 video-request.mjs），这是人物一致的真正开关。
    const imgs = (Array.isArray(referenceImages) ? referenceImages : []).filter(Boolean).slice(0, 3);
    const marker = [
      references.join(','),
      imgs.length ? `已附 ${imgs.length} 张角色定妆照参考图（reference 模式锁定）` : '无参考图，仅文字描述，人物一致性有限',
    ].filter(Boolean).join('；');
    const finalPrompt = `${String(prompt || '').trim()}\n[连续性参考] ${marker}`;
    return {
      imgs,
      finalPrompt,
      // seed 同样要真的进创建体（video-request 见到 src.seed 才会写 body.seed）：
      // 以前适配器压根没解构 seed，video-request 那条转发分支永远走不到。
      body: {
        ...params,
        ...(Number.isFinite(seed) ? { seed } : {}),
        ...(imgs.length ? { images: imgs } : {}),
      },
    };
  };
  const clean = cleanModel;
  return {
    async generate({ prompt, model, seed, params, references, referenceImages } = {}) {
      if (typeof generateVideo !== 'function') return { status: 'failed', error: '视频引擎未接入' };
      const { finalPrompt, body } = build({ prompt, model, seed, params, references, referenceImages });
      try {
        const result = await startWithRetry(() => generateVideo(model?.provider, model?.id, finalPrompt, body), '视频生成失败', retryDelays);
        if (!result?.video) return { status: 'failed', error: result?.error || '视频模型未返回片子', model: clean(model) };
        const stored = typeof saveArtifact === 'function' ? normalizeStored(await saveArtifact({ type: 'video', url: result.video, prompt: finalPrompt }), result.video) : { url: result.video, local: true, reason: '' };
        const notes = adapterNotes(result);
        return { status: 'succeeded', model: clean(model), output: { type: 'video', url: stored.url || result.video, prompt: finalPrompt, ...(notes.length ? { degradation: notes } : {}), ...(stored.local ? {} : { localizeError: stored.reason }) } };
      } catch (error) { return { status: 'failed', error: String(error?.message || error).slice(0, 200), model: clean(model) }; }
    },
    // 只创建、立刻返回任务号。**连续创作走这条**：上游排队常常几分钟，
    // 让一个 HTTP 请求干等那么久，既会被网关掐断（工坊早就因此改成短轮询），
    // 也会让用户以为卡死了。
    async start({ prompt, model, seed, params, references, referenceImages } = {}) {
      if (typeof startVideoJob !== 'function') return { status: 'failed', error: '视频引擎未接入（缺 startVideoJob）' };
      const { finalPrompt, body } = build({ prompt, model, seed, params, references, referenceImages });
      try {
        const r = await startWithRetry(() => startVideoJob(model?.provider, model?.id, finalPrompt, body), '视频任务创建失败', retryDelays);
        const notes = adapterNotes(r);
        // 少数上游会在创建响应里直接给成品
        if (r?.video) return { status: 'succeeded', model: clean(model), video: r.video, prompt: finalPrompt, ...(notes.length ? { degradation: notes } : {}) };
        if (r?.task_id) return { status: 'running', model: clean(model), taskId: String(r.task_id), prompt: finalPrompt, ...(notes.length ? { degradation: notes } : {}) };
        return { status: 'failed', model: clean(model), error: r?.error || '视频任务没有返回任务号' };
      } catch (error) { return { status: 'failed', model: clean(model), error: String(error?.message || error).slice(0, 200) }; }
    },
    // 查一次并落盘。**不在这里等**：等多久由调用方（前端轮询 / 人类点「查一次」）决定。
    async settle({ taskId, model, promptText } = {}) {
      if (typeof checkVideoJob !== 'function') return { status: 'failed', error: '视频引擎未接入（缺 checkVideoJob）' };
      if (!taskId) return { status: 'failed', error: '这一版没有任务号，无法查询' };
      try {
        const q = await checkVideoJob(model?.provider, model?.id, taskId);
        if (q?.video) {
          const stored = typeof saveArtifact === 'function' ? normalizeStored(await saveArtifact({ type: 'video', url: q.video, prompt: promptText || '' }), q.video) : { url: q.video, local: true, reason: '' };
          return { status: 'succeeded', model: clean(model), output: { type: 'video', url: stored.url || q.video, prompt: promptText || '', ...(stored.local ? {} : { localizeError: stored.reason }) } };
        }
        if (q?.error && q.status !== 'pending') return { status: 'failed', model: clean(model), error: String(q.error) };
        return { status: 'running', taskId, upstream: q?.status || 'pending' };
      } catch (error) { return { status: 'failed', model: clean(model), error: String(error?.message || error).slice(0, 200) }; }
    },
  };
}
