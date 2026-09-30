import { effectiveCapabilities } from '../shared/model-capabilities.mjs';
import { canonicalStepKey } from './run-effects.mjs';
import { mediaDeliveryKey } from './media-embed.mjs';
import { persistYuanshuUser, persistYuanshuAssistant, resumePersistenceState } from './yuanshu-session.mjs';
import { sseWrite, startSseHeartbeat } from './sse.mjs';

// Keep old stale-auto/provider protection, but never replace a removed selection.
export function resolveChatSelection({ models, requested, modelKey }) {
  let key = modelKey;
  if (typeof requested === 'string' && requested.includes('/')) {
    const slash = requested.indexOf('/');
    const provider = requested.slice(0, slash), id = requested.slice(slash + 1);
    if (provider === 'auto' || /^auto(-smart)?$/i.test(id)) {
      if (!key || key.provider === 'auto') key = { provider: 'auto', id: 'auto' };
    } else if (!['deepseek', 'nvidia'].includes(provider)) key = { provider, id };
  }
  if (!key || key.provider === 'auto' || key.id === 'auto') return { kind: 'auto', key };
  const model = models.find(m => m.provider === key.provider && m.id === key.id);
  if (!model) throw new Error(`所选模型未找到：${key.provider}/${key.id}，请重新选择`);
  if (model.enabled === false) throw new Error(`所选模型已停用，不可用：${key.provider}/${key.id}`);
  const caps = effectiveCapabilities(model);
  const kind = caps.chat ? 'chat' : caps.video ? 'video' : caps.image ? 'image' : null;
  if (!kind) throw new Error('此模型需要语音通话、朗读或识别专用入口，不能用于聊天生成');
  return { kind, key: { provider: model.provider, id: model.id }, model };
}

// The runs service consumes SSE, not a JSON media response. Keep this branch
// independent of text agents, with the same persistence and generation fence.
export async function runSelectedMedia({ req, res, entry, generation, model, kind, message,
  runContext = {}, entries = [], generateImage, generateVideo, saveArtifact, invalidate = () => {} }) {
  const controller = new AbortController();
  const { signal } = controller;
  const current = () => entry.gen === generation;
  const live = () => current() && !signal.aborted && !res.writableEnded && !res.destroyed;
  const emit = (type, data) => { if (live()) sseWrite(res, type, data); };
  const stop = () => controller.abort(new Error('媒体生成已停止；上游可能仍在处理，请勿重复提交'));
  const cancel = () => stop();
  entry.mediaAbort = stop;
  req.on('close', cancel);
  runContext.signal?.addEventListener('abort', cancel, { once: true });
  const timeoutMs = Math.max(1, Math.min(600000, (Number(runContext.executionDeadlineAt) || Date.now() + 600000) - Date.now()));
  const timer = setTimeout(() => controller.abort(new Error('媒体生成等待超时；结果尚未确认，请先检查任务，避免重复扣费')), timeoutMs);
  const heartbeat = startSseHeartbeat(res);
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(signal.reason);
    signal.addEventListener('abort', abortListener, { once: true });
  });
  // Cancellation can precede the first operation; keep its rejection handled.
  void aborted.catch(() => {});
  const bounded = async operation => {
    signal.throwIfAborted();
    const result = await Promise.race([Promise.resolve().then(operation), aborted]);
    signal.throwIfAborted();
    if (!current()) throw new Error('本轮已被新的请求替代');
    return result;
  };
  const selected = { provider: model.provider, id: model.id };
  const metadata = { model: selected, requestedModel: selected, engine: 'media' };
  const { effects, runId } = runContext;
  const step = canonicalStepKey('chat_media', { model: selected, kind, message });
  let started = false, completed = false;
  try {
    // Observe an already-aborted request inside try so cleanup still runs.
    if (req.destroyed || runContext.signal?.aborted) stop();
    signal.throwIfAborted();
    emit('model_selected', { model: selected, requestedModel: selected });
    const saved = resumePersistenceState(entries, message, runContext.resume);
    if (!saved.userPersisted) persistYuanshuUser(entry.sm, message);
    // Older runs have no effect ledger: a restart must not buy a second image.
    if (runContext.resume && (!effects || !runId || !effects.get(runId, step))) {
      throw new Error('无法安全恢复这次媒体生成，已阻止重复提交；请先检查已有产物或上游任务');
    }
    const decision = effects && runId ? effects.begin(runId, step, { toolName: 'chat_media', replayPolicy: 'never' }) : { action: 'execute' };
    if (decision.action === 'blocked') throw new Error('上次媒体请求结果尚未确认，已阻止重复生成；请检查已有产物或上游任务');
    let media = decision.result;
    if (decision.action === 'execute') {
      started = true;
      emit('note', { text: `正在使用 ${model.provider}/${model.id} 生成${kind === 'image' ? '图片' : '视频'}…` });
      const result = await bounded(() => kind === 'image'
        ? generateImage(model.provider, model.id, message, undefined, undefined, { signal })
        : generateVideo(model.provider, model.id, message, { signal }));
      const url = kind === 'image' ? result : result?.video;
      if (!url) throw new Error(result?.error || '所选模型没有返回媒体结果');
      const localized = await bounded(() => saveArtifact({ type: kind, url, prompt: message, signal }));
      media = { type: kind, url: localized?.url || url };
      if (!localized?.local) emit('note', { text: `媒体已生成，但未保存到本机：${localized?.reason || '本地保存失败'}。临时链接可能过期。` });
      // Base64 exceeds the bounded journal payload. Never cache a truncated image.
      if (effects && runId && localized?.local && media.url.length < 12000) {
        effects.complete(runId, step, media);
        completed = true;
      }
    }
    if (!media?.url || !['image', 'video'].includes(media.type)) throw new Error('已保存的媒体结果不可用，请检查产物记录');
    if (!saved.mediaKeys.has(mediaDeliveryKey(media.url))) persistYuanshuAssistant(entry.sm, [media], [], metadata);
    emit('model_used', metadata);
    emit('media', media);
    emit('done', metadata);
  } catch (error) {
    // Abort prevents media delivery, but a still-open task stream needs an error.
    if (current() && !res.writableEnded && !res.destroyed && !req.destroyed) {
      try { sseWrite(res, 'error', { message: String(error?.message || error) }); } catch {}
    }
  } finally {
    if (started && !completed && effects && runId) {
      try { effects.markUncertain(runId, step, 'media outcome not safely cached; do not repurchase'); } catch {}
    }
    clearTimeout(timer);
    clearInterval(heartbeat);
    signal.removeEventListener('abort', abortListener);
    runContext.signal?.removeEventListener('abort', cancel);
    req.removeListener('close', cancel);
    if (entry.mediaAbort === stop) delete entry.mediaAbort;
    if (current()) { entry.busy = false; invalidate(); }
    try { res.end(); } catch {}
  }
}
