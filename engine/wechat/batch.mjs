// ===== wechat-batch.mjs —— 连续消息合并（2026-10-28）=====
//
// 设计借鉴 Hermes 的 text batching：用户连着发三条（"在吗" "帮我看看" "就是那个报错"），
// 逐条处理等于让她跑三轮、回三遍、花三次钱。合成一条再想，才像人。
//
// 规则：
//   · 每条消息进来重置等待计时（debounce），默认 1200ms 内没新消息就 flush；
//   · 最长等待 maxWaitMs（默认 6000ms），防止话痨把队列一直拖着；
//   · flush 时把多条文本按顺序拼起来，用最后一条的 context_token（最新）。
export function createBatcher({ delayMs = 1200, maxWaitMs = 6000, onFlush, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof onFlush !== "function") throw new Error("onFlush 必填");
  const buckets = new Map(); // key -> { items, timer, firstAt }

  const flush = (key) => {
    const b = buckets.get(key);
    if (!b) return;
    buckets.delete(key);
    if (b.timer) clearTimer(b.timer);
    if (!b.items.length) return;
    const merged = {
      ...b.items[b.items.length - 1],
      text: b.items.map((x) => String(x.text || "")).filter(Boolean).join("\n"),
      mergedCount: b.items.length,
      mergedFrom: b.items.map((x) => String(x.text || "")).filter(Boolean),
    };
    try { onFlush(key, merged, b.items); } catch {}
  };

  return {
    /** 收一条；返回当前积累条数。 */
    push(key, item) {
      const k = String(key || "");
      if (!k) return 0;
      const t = now();
      let b = buckets.get(k);
      if (!b) { b = { items: [], timer: null, firstAt: t }; buckets.set(k, b) }
      b.items.push(item);
      if (b.timer) clearTimer(b.timer);
      const elapsed = t - b.firstAt;
      const wait = Math.max(0, Math.min(delayMs, maxWaitMs - elapsed));
      b.timer = setTimer(() => flush(k), wait);
      return b.items.length;
    },
    /** 立即吐出（停机 / 单测用）。 */
    flushNow(key) { flush(key) },
    pending(key) { return (buckets.get(key)?.items || []).length },
    size() { return buckets.size },
  };
}
