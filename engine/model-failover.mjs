// engine/model-failover.mjs —— 按失败类型决定"重试"还是"换通道"（2026-10-20）
//
// 起因：Harness² 探针查历史时发现，她每晚的自我反思最近 3 次里 2 次失败，
// 原因是 429 额度上限、fetch failed 网络、以及被路由到视频模型（后者已单独修）。
// 原来的行为是：抛错 → 整轮失败 → 当晚没反思。但其实这三种错的处理方式完全不同：
//   · 额度/鉴权（429/401/402/403）→ 同一个模型重试没用，必须**换通道**
//   · 网络（fetch failed / ETIMEDOUT / ECONNRESET）→ 换通道没必要，**退避重试同一模型**
//   · 模型选错（is a video model / 400 参数错）→ **换一个能干的模型**
//   · 其它（内容错误、工具错误）→ 不重试，如实抛
//
// 这个模块只做"决策"，不碰具体 provider，便于单测。
import { isTextCapableModel } from './model-router.mjs';

export const FAILOVER_MAX_ATTEMPTS = 3;

export function classifyModelFailure(error) {
  const msg = String(error?.message || error || '');
  if (/(?:HTTP\s*)?(?:401|402|403|429|529)\b/.test(msg)
    || /使用上限|额度|quota|rate.?limit|too many requests|GoUsageLimit|insufficient_quota/i.test(msg)) return 'quota';
  if (/fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|timed? ?out/i.test(msg)) return 'network';
  if (/is a (?:video|image|audio|tts) model|not a chat model|model_not_found|invalid model/i.test(msg)) return 'bad-model';
  return 'other';
}

// 该不该重试、重试时换不换模型
export function planRetry(kind, attemptNo, { maxAttempts = FAILOVER_MAX_ATTEMPTS } = {}) {
  if (attemptNo >= maxAttempts) return { retry: false, why: '已达最大重试次数' };
  if (kind === 'quota' || kind === 'bad-model') return { retry: true, switchModel: true, why: kind === 'quota' ? '额度/鉴权限流 → 换通道' : '模型不适合 → 换模型' };
  if (kind === 'network') return { retry: true, switchModel: false, why: '网络抖动 → 同模型退避重试' };
  return { retry: false, why: '非通道类错误，不重试' };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带失败的模型调用。
 * @param {object}   opts
 * @param {object}   opts.initial      首选模型
 * @param {Function} opts.call         (model) => Promise<any>
 * @param {Function} [opts.pickNext]   (triedModels) => 下一个模型 | undefined
 * @param {Function} [opts.onSwitch]   ({from,to,kind,why}) => void
 * @param {number}   [opts.maxAttempts]
 * @param {Function} [opts.sleep]      (ms) => Promise
 */
export async function withModelFailover({
  initial, call, pickNext, onSwitch, maxAttempts = FAILOVER_MAX_ATTEMPTS, sleep = defaultSleep,
} = {}) {
  const tried = [];
  let model = initial;
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    if (!model) throw lastError || new Error('no_model_available');
    tried.push(model);
    try {
      return { result: await call(model), model, attempts: attempt, tried: tried.length };
    } catch (error) {
      lastError = error;
      const kind = classifyModelFailure(error);
      const plan = planRetry(kind, attempt, { maxAttempts });
      if (!plan.retry) throw Object.assign(new Error(`${String(error?.message || error)}（失败处理：${plan.why}）`), { failoverKind: kind, failoverWhy: plan.why, cause: error });
      if (plan.switchModel) {
        const next = typeof pickNext === 'function' ? pickNext(tried) : undefined;
        if (!next) throw Object.assign(new Error(`${String(error?.message || error)}（失败处理：没有可切换的通道）`), { failoverKind: kind, failoverWhy: '没有可切换的通道', cause: error });
        if (!isTextCapableModel(next)) throw Object.assign(new Error(`${String(error?.message || error)}（失败处理：下一个通道不是文本模型）`), { failoverKind: kind, failoverWhy: '下一个通道不是文本模型', cause: error });
        try { onSwitch?.({ from: model, to: next, kind, why: plan.why }); } catch {}
        model = next;
        continue;
      }
      // 同模型退避：1s、3s
      await sleep(attempt === 1 ? 1000 : 3000);
    }
  }
  throw lastError || new Error('model_failover_exhausted');
}
