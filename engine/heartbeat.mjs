// engine/heartbeat.mjs —— 智能体心跳：定期自己醒来看一圈，有「该让主人知道」的事就主动说，没有就静默。
// 刻意不调模型：心跳每半小时一次，调模型会白烧额度；要判断的都是确定性事实（逾期承诺、等确认的卡、卡住的名额）。
// 同一件事只提醒一次（key 去重，TTL 后才会再提）；夜间静默时段不打扰，事情留到早上合并成一条。
import fs from "node:fs";
import path from "node:path";

const HOUR = 3600_000;

export function createHeartbeat({ sources = [], notifier, file, intervalMs = 30 * 60_000, renotifyMs = 24 * HOUR,
  quiet = { from: 23, to: 8 }, now = Date.now, log = console } = {}) {
  let seen = {};
  try { if (file && fs.existsSync(file)) seen = JSON.parse(fs.readFileSync(file, "utf8")).seen || {}; } catch { seen = {}; }
  let timer = null, last = null;

  const persist = () => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ seen })); } catch { /* 心跳状态丢了最多重复提醒一次 */ }
  };
  const inQuiet = (t) => {
    if (!quiet) return false;
    const h = new Date(t).getHours();
    return quiet.from > quiet.to ? (h >= quiet.from || h < quiet.to) : (h >= quiet.from && h < quiet.to);
  };

  async function beat() {
    const t = now();
    const found = [];
    for (const source of sources) {
      try { for (const it of (await source()) || []) if (it?.key && it.text) found.push(it); }
      catch (e) { log.warn?.(`[heartbeat] 巡检源失败: ${String(e?.message || e).slice(0, 80)}`); }
    }
    const keys = new Set(found.map((f) => f.key));
    for (const k of Object.keys(seen)) if (!keys.has(k) && t - seen[k] > renotifyMs) delete seen[k];
    const fresh = found.filter((f) => !(seen[f.key] && t - seen[f.key] < renotifyMs));
    last = { at: t, found: found.length, fresh: fresh.length, sent: false };
    if (!fresh.length || inQuiet(t)) { persist(); return last; }
    const lines = fresh.slice(0, 5).map((f) => `· ${f.text}`);
    if (fresh.length > 5) lines.push(`· 另有 ${fresh.length - 5} 件`);
    await notifier.notify({ kind: "heartbeat", title: `元枢 · ${fresh.length} 件事等你`, body: lines.join("\n"), key: "heartbeat", toWechat: true });
    for (const f of fresh) seen[f.key] = t;
    persist();
    last.sent = true;
    return last;
  }

  return {
    beat,
    status: () => ({ running: !!timer, intervalMs, last }),
    start() { if (!timer) { timer = setInterval(() => { beat().catch(() => {}); }, intervalMs); timer.unref?.(); } },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
