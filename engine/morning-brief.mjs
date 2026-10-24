// engine/morning-brief.mjs —— 今日晨报（2026-10-22）
//
// 灵感来自 Claude Duet 的"早晨简报"：不等用户问，先把「昨夜做了什么 / 今天该做什么 /
// 哪里出过问题」摆出来。这里的取舍是**不调用模型**——全部由已落盘事实拼出来，
// 所以零成本、可重复、不会被模型编造。
import fs from 'node:fs';
import path from 'node:path';
import { loadPromises } from './promises.mjs';
import { sealedSummary } from './sealed-window.mjs';

export const BRIEF_DIR = '记忆/运行时';
export const SLOW_LOG = '记忆/运行时/慢请求.jsonl';
export const PROBE_LOG = '文档/harness-试验.md';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } };

function readLines(file, limit = 2000) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit) } catch { return [] }
}

/** 昨夜定时任务：从昨晚 18:00 起算，取每个任务最近几次运行 */
export function lastNightTasks(agentDir, { now = new Date(), sinceHour = 18 } = {}) {
  const data = readJson(path.join(agentDir, 'time-tasks.json'));
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  // 2026-10-22 修：固定"18:00 起算"在傍晚会把凌晨那次漏掉（实测显示"昨夜没有任务"）。
  // 改成滚动 18 小时窗口：既覆盖夜里，也不会把上周的算进来。
  const from = new Date(now.getTime() - 24 * 3600_000);
  const out = [];
  for (const t of tasks) {
    for (const h of (Array.isArray(t.history) ? t.history : [])) {
      // startedAt 是 epoch 毫秒（不是 ISO 字符串）；Date.parse(数字) 得 NaN，会导致整段被静默跳过
      const raw = h?.startedAt;
      const at = typeof raw === 'number' ? raw : Date.parse(String(raw || ''));
      if (!Number.isFinite(at) || at < from.getTime()) continue;
      out.push({
        label: String(t.label || t.id || '定时任务'),
        at: new Date(at).toISOString(),
        status: String(h.status || ''),
        durationMs: Number(h.durationMs) || 0,
        snippet: String(h.result || '').replace(/\s+/g, ' ').slice(0, 80),
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** 待兑现承诺：到期/逾期的优先 */
export function duePromises(wsRoot, { now = new Date() } = {}) {
  let list = [];
  try { list = loadPromises(wsRoot) || [] } catch { return { pending: 0, overdue: [], recent: [] } }
  // 账本用 status 表达状态：pending 才算"还欠着"，expired/dropped/kept 都是已处置
  const open = list.filter((p) => String(p?.status || '') === 'pending');
  const overdue = open.filter((p) => {
    const due = Date.parse(p?.due || p?.dueAt || p?.deadline || '');
    return Number.isFinite(due) && due < now.getTime();
  });
  return {
    pending: open.length,
    overdue: overdue.slice(0, 3).map((p) => String(p.text || '').slice(0, 60)),
    recent: open.slice(-3).map((p) => String(p.text || '').slice(0, 60)),
  };
}

/** 近 24 小时慢请求：条数 + 最慢两条 */
export function slowSummary(wsRoot, { now = Date.now(), hours = 24, limit = 2, recentHours = 6, since = null } = {}) {
  const rows = readLines(path.join(wsRoot, SLOW_LOG), 3000)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
    .filter((r) => {
      const t = Date.parse(r.at || '');
      return Number.isFinite(t) && now - t <= hours * 3600_000;
    });
  // 2026-10-24：优先按"本次进程启动以来"，没有就退回最近 N 小时。
  // 这样修完之后的慢请求才算数，不会把修复前的旧账当成现状。
  const cutoff = Number.isFinite(since) ? since : now - recentHours * 3600_000;
  const recent = rows.filter((r) => Date.parse(r.at || '') >= cutoff);
  const recentTop = recent
    .slice()
    .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
    .slice(0, limit)
    .map((r) => ({ key: `${r.method || ''} ${r.path || ''}`.trim(), durationMs: r.durationMs || 0 }));
  const allTop = rows
    .slice()
    .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
    .slice(0, limit)
    .map((r) => ({ key: `${r.method || ''} ${r.path || ''}`.trim(), durationMs: r.durationMs || 0 }));
  return {
    count: rows.length,
    recentCount: recent.length,
    recentHours,
    top: recent.length ? recentTop : allTop,
    isRecent: recent.length > 0,
  };
}


/** 最近一次试验结论（Probe 写的那份） */
export function lastProbe(wsRoot) {
  const rows = readLines(path.join(wsRoot, PROBE_LOG), 50).filter((l) => l.startsWith('- '));
  if (!rows.length) return '';
  return rows[rows.length - 1].replace(/^-\s*/, '').slice(0, 120);
}

/** 拼晨报：结构化 + 句子。没有内容就说没有，不硬凑。 */
export function buildMorningBrief(wsRoot, { agentDir, now = new Date() } = {}) {
  const night = lastNightTasks(agentDir, { now });
  const failed = night.filter((t) => !/ok|success|done/i.test(t.status));
  const promises = duePromises(wsRoot, { now });
  const bootAt = (() => { try { return Date.now() - process.uptime() * 1000 } catch { return null } })();
  const slow = slowSummary(wsRoot, { now: now.getTime(), since: bootAt });
  const probe = lastProbe(wsRoot);

  const lines = [];
  if (night.length) {
    const ok = night.length - failed.length;
    lines.push(`昨夜跑了 ${night.length} 次定时任务，成功 ${ok} 次${failed.length ? `、失败 ${failed.length} 次` : ''}。`);
  } else {
    lines.push('昨夜没有定时任务运行。');
  }
  if (failed.length) {
    lines.push(`失败的是「${failed[0].label}」：${failed[0].snippet || '没有留下结果'}。`);
  }
  if (promises.pending) {
    lines.push(`账上还有 ${promises.pending} 件答应过你的事${promises.overdue.length ? `，其中 ${promises.overdue.length} 件已逾期` : ''}。`);
  }
  // 2026-10-24：区分"近 6 小时"与"24h 历史峰值"——198 秒那次是卡顿期留下的旧账，不该当成现状
  if (slow.recentCount) {
    const t = slow.top[0];
    const sinceMin = Math.max(1, Math.round((Date.now() - (bootAt || Date.now())) / 60000));
    lines.push(`本次启动 ${sinceMin} 分钟内 ${slow.recentCount} 次慢请求${t ? `，最慢是 ${t.key}（${(t.durationMs / 1000).toFixed(1)} 秒）` : ''}。`);
  } else if (slow.count) {
    const t = slow.top[0];
    lines.push(`本次启动以来没有慢请求（24 小时内历史峰值 ${t ? `${t.key} ${(t.durationMs / 1000).toFixed(0)} 秒` : '—'}）。`);
  } else {
    lines.push('过去 24 小时没有慢请求。');
  }
  if (probe) {
    // "1025662→1308591ms" 这种成对数字：两个都要换，否则会剩一个裸数字
    const human = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分钟` : `${(ms / 1000).toFixed(1)} 秒`);
    const humanized = String(probe).replace(/(\d{4,})(?=ms|→)/g, (_, n) => human(Number(n))).replace(/(分钟|秒)ms/g, "$1");
    lines.push(`最近一次外壳试验：${humanized}`);
  }
  // 2026-10-24：每轮耗时（只看最近 30 轮的首字中位数，用来发现"突然变慢"）
  try {
    const rows = fs.readFileSync(path.join(wsRoot, '记忆/运行时/每轮耗时.jsonl'), 'utf8')
      .split('\n').filter(Boolean).slice(-30)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((r) => r && typeof r.firstDeltaMs === 'number');
    if (rows.length >= 5) {
      const arr = rows.map((r) => r.firstDeltaMs).sort((a, b) => a - b);
      const p50 = arr[Math.floor(arr.length / 2)];
      lines.push(`最近 ${rows.length} 轮：首字中位 ${(p50 / 1000).toFixed(1)} 秒（上下文装配 ${(() => { const c = rows.map((r) => r.contextMs).filter((v) => typeof v === 'number').sort((a, b) => a - b); return c.length ? c[Math.floor(c.length / 2)] : 0 })()} 毫秒）。`);
    }
  } catch {}
  // 2026-10-23：后台作业池
  try {
    const jobs = JSON.parse(fs.readFileSync(path.join(wsRoot, '记忆/运行时/后台任务.json'), 'utf8'))?.jobs || [];
    const running = jobs.filter((j) => j?.status === 'running');
    const queued = jobs.filter((j) => j?.status === 'queued');
    if (running.length) lines.push(`后台有 ${running.length} 个作业在跑${queued.length ? `、${queued.length} 个排队` : ''}：${running.slice(0, 2).map((j) => j.title).join('、')}。`);
    else if (queued.length) lines.push(`后台有 ${queued.length} 个作业排队中。`);
  } catch {}
  // 封存窗口：让"用来评测的数据"在晨报里可见，而不是藏在 json 里
  try {
    const sealed = sealedSummary(wsRoot, now.getTime());
    if (sealed.active) lines.push(`有 ${sealed.active} 个封存窗口在跑${sealed.nextDueDays != null ? `，最早还有 ${sealed.nextDueDays} 天到期` : ''}（窗口内数据不参与调参）。`);
    else if (sealed.done) lines.push(`封存评测已累计 ${sealed.done} 次${sealed.lastVerdict ? `，最近一次：${sealed.lastVerdict}` : ''}。`);
  } catch {}

  return {
    date: (() => { try { return now.toLocaleDateString('sv-SE') } catch { return now.toISOString().slice(0, 10) } })(),
    generatedAt: now.toISOString(),
    night: { runs: night.length, failed: failed.length, items: night.slice(-5) },
    promises,
    slow,
    probe,
    lines,
    headline: failed.length ? `${failed.length} 个夜间任务失败` : promises.overdue.length ? `${promises.overdue.length} 件承诺逾期` : '一切正常',
  };
}

/** 落盘缓存：同一份数据反复请求不重复算 */
export function briefFile(wsRoot, date) { return path.join(wsRoot, BRIEF_DIR, `晨报-${date}.json`) }

export function readCachedBrief(wsRoot, date) {
  const j = readJson(briefFile(wsRoot, date));
  if (!j?.generatedAt) return null;
  return j;
}

export function writeCachedBrief(wsRoot, brief) {
  try {
    const file = briefFile(wsRoot, brief.date);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(brief, null, 2), 'utf8');
    return file;
  } catch { return '' }
}
