// engine/timer-watch.mjs —— 定时器耗时探针（2026-10-24）
//
// 现象：事件循环停顿 7.6 秒，但当时没有业务请求、也没有 GC 记录 → 后台定时任务里的同步活。
// 做法：包装 setInterval/setTimeout，回调耗时 >300ms 就打一行日志并标出注册位置，
// 这样下一次停顿能直接点名是哪个定时器。
export function installTimerWatch({ thresholdMs = 300, log = console.log } = {}) {
  if (globalThis.__timerWatchInstalled) return false;
  globalThis.__timerWatchInstalled = true;

  const origin = (depth = 2) => {
    const e = new Error();
    const line = (e.stack || '').split('\n')[depth] || '';
    return line.replace(/^\s*at\s+/, '').replace(process.cwd ? new RegExp(`^${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) : /^$/, '').slice(0, 120);
  };

  const wrap = (fn, label) => {
    if (typeof fn !== 'function') return fn;
    return function patched(...args) {
      const t0 = Date.now();
      try {
        return fn.apply(this, args);
      } finally {
        const ms = Date.now() - t0;
        if (ms >= thresholdMs) log(`[slow-timer] ${ms}ms ← ${label}`);
      }
    };
  };

  const realSetInterval = global.setInterval;
  const realSetTimeout = global.setTimeout;

  global.setInterval = function (fn, ms, ...args) {
    return realSetInterval(wrap(fn, `setInterval(${ms}ms) @ ${origin(2)}`), ms, ...args);
  };
  global.setTimeout = function (fn, ms, ...args) {
    // 只关心长延时（>=1000ms）的定时任务，避免把每个小延迟都包一层
    if (typeof fn !== 'function' || Number(ms) < 1000) return realSetTimeout(fn, ms, ...args);
    return realSetTimeout(wrap(fn, `setTimeout(${ms}ms) @ ${origin(2)}`), ms, ...args);
  };
  try { global.setInterval.__patched = true } catch {}
  return true;
}
