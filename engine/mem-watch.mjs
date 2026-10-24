// engine/mem-watch.mjs —— 内存采样（2026-10-24）
//
// 目的：查"为什么卡"。事件循环停顿 40–54 秒时，在途只有常驻 SSE，说明是 GC/内存回收。
// 这里每 60 秒采一次 rss / heap，落 jsonl；增长异常时打一行警告，方便事后对时间轴。
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';

export const MEM_LOG = '记忆/运行时/内存.jsonl';
const MAX_LINES = 8000;

export function createMemWatch({ wsRoot, everyMs = 60_000, log = console.log } = {}) {
  const file = path.join(wsRoot, MEM_LOG);
  let timer = null;
  let lastRss = 0;

  const sample = (extra = {}) => {
    const m = process.memoryUsage();
    const spaces = (() => {
      try { return v8.getHeapSpaceStatistics().map((s) => ({ name: s.space_name, size: Math.round(s.space_size / 1048576) })) } catch { return [] }
    })();
    const record = {
      at: new Date().toISOString(),
      rssMB: Math.round(m.rss / 1048576),
      heapUsedMB: Math.round(m.heapUsed / 1048576),
      heapTotalMB: Math.round(m.heapTotal / 1048576),
      externalMB: Math.round(m.external / 1048576),
      arrayBuffersMB: Math.round(m.arrayBuffers / 1048576),
      spaces,
      ...extra,
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) fs.writeFileSync(file, lines.slice(-Math.floor(MAX_LINES / 2)).join('\n') + '\n', 'utf8');
    } catch {}
    return record;
  };

  return {
    start(getExtra) {
      if (timer) return;
      timer = setInterval(() => {
        let extra = {};
        try { extra = getExtra?.() || {} } catch {}
        const r = sample(extra);
        // 增长超过 150MB 或 rss 超过 900MB 时提示（不做自动重启，强杀会丢正在跑的活）
        if (lastRss && r.rssMB - lastRss > 150) log(`[mem] rss 突增 ${lastRss}MB → ${r.rssMB}MB（heap ${r.heapUsedMB}MB / external ${r.externalMB}MB）`);
        else if (r.rssMB > 900) log(`[mem] rss ${r.rssMB}MB 偏高（heap ${r.heapUsedMB}MB / external ${r.externalMB}MB）`);
        lastRss = r.rssMB;
      }, everyMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null },
    sample,
    recent(limit = 60) {
      try {
        return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)
          .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
      } catch { return [] }
    },
  };
}
