// engine/job-pool.mjs —— 后台作业池（2026-10-23）
//
// 为什么需要：元枢其实能派活（delegate_task / dsh_task），但派出去的活**看不见**——
// 界面不知道有几个在跑、跑了多久、卡在哪。DSH 那种"随手挂 20 个后台"靠的是一张作业表，
// 这里先补最小的一张：排队、限并发、可查询、可取消、落盘留近况。
//
// 用法：
//   const pool = createJobPool({ file, concurrency: 2 })
//   const job = pool.submit({ kind: 'dsh_task', title: '写一份调研' }, async (signal) => { ... return '文本' })
import fs from 'node:fs';
import path from 'node:path';

export const JOB_FILE = '记忆/运行时/后台任务.json';
const KEEP = 60;

export function createJobPool({ file = null, concurrency = 2, now = () => new Date().toISOString() } = {}) {
  let jobs = [];
  let seq = 0;
  const queue = [];
  const running = new Map(); // id -> AbortController
  let active = 0;

  const persist = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ jobs: jobs.slice(-KEEP) }, null, 2), 'utf8');
    } catch {}
  };

  const publicJob = (j) => ({
    id: j.id,
    kind: j.kind,
    title: j.title,
    status: j.status,
    queuedAt: j.queuedAt,
    startedAt: j.startedAt || null,
    finishedAt: j.finishedAt || null,
    durationMs: j.startedAt ? (Date.parse(j.finishedAt || now()) - Date.parse(j.startedAt)) : 0,
    resultPreview: j.result ? String(j.result).slice(0, 200) : '',
    error: j.error ? String(j.error).slice(0, 200) : '',
  });

  const pump = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      if (job.cancelled) continue;
      active += 1;
      job.status = 'running';
      job.startedAt = now();
      const ctrl = new AbortController();
      running.set(job.id, ctrl);
      persist();
      Promise.resolve()
        .then(() => job.run(ctrl.signal))
        .then((result) => {
          job.status = ctrl.signal.aborted ? 'cancelled' : 'done';
          job.result = typeof result === 'string' ? result : JSON.stringify(result ?? '').slice(0, 4000);
        })
        .catch((err) => {
          job.status = ctrl.signal.aborted ? 'cancelled' : 'failed';
          job.error = String(err?.message || err);
        })
        .finally(() => {
          job.finishedAt = now();
          running.delete(job.id);
          active -= 1;
          persist();
          pump();
        });
    }
  };

  return {
    submit({ kind = 'job', title = '' } = {}, run) {
      if (typeof run !== 'function') throw new Error('job_pool_run_required');
      seq += 1;
      const job = {
        id: `j_${Date.now().toString(36)}_${seq}`,
        kind: String(kind).slice(0, 40),
        title: String(title || kind).slice(0, 120),
        status: 'queued',
        queuedAt: now(),
        run,
      };
      jobs.push(job);
      if (jobs.length > KEEP * 2) jobs = jobs.slice(-KEEP * 2);
      queue.push(job);
      persist();
      pump();
      return publicJob(job);
    },
    /**
     * 只登记不排队：用于"已经在跑的长活"（出图/出片/调研/脱链）。
     * 返回句柄：done(result) / fail(err) / cancel()，以及 job。
     */
    track({ kind = 'task', title = '' } = {}) {
      seq += 1;
      const job = {
        id: `j_${Date.now().toString(36)}_${seq}`,
        kind: String(kind).slice(0, 40),
        title: String(title || kind).slice(0, 120),
        status: 'running',
        queuedAt: now(),
        startedAt: new Date(now()).toISOString(),
        run: null,
      };
      jobs.push(job);
      if (jobs.length > KEEP * 2) jobs = jobs.slice(-KEEP * 2);
      // 用一个独立控制器支持取消（不塞进 running 队列，避免影响并发计数）
      const ctrl = new AbortController();
      running.set(job.id, ctrl);
      persist();
      const finish = (status, extra = {}) => {
        job.status = status;
        job.finishedAt = now();
        if (extra.result) job.result = String(extra.result).slice(0, 400);
        if (extra.error) job.error = String(extra.error).slice(0, 400);
        running.delete(job.id);
        persist();
      };
      return {
        job: publicJob(job),
        signal: ctrl.signal,
        done: (result = '') => finish('done', { result }),
        fail: (err) => finish('failed', { error: String(err?.message || err || '失败') }),
        cancel: () => { try { ctrl.abort('user_cancel') } catch {}; finish('cancelled') },
      };
    },
    list() {
      return jobs.slice().reverse().map(publicJob);
    },
    get(id) { const j = jobs.find((x) => x.id === id); return j ? publicJob(j) : null },
    cancel(id) {
      const j = jobs.find((x) => x.id === id);
      if (!j) return { ok: false, reason: 'not_found' };
      if (j.status === 'queued') { j.cancelled = true; j.status = 'cancelled'; j.finishedAt = now(); persist(); return { ok: true } }
      const ctrl = running.get(id);
      if (ctrl) { try { ctrl.abort('user_cancel') } catch {}; return { ok: true } }
      return { ok: false, reason: 'not_running' };
    },
    summary() {
      const activeJobs = jobs.filter((j) => j.status === 'running');
      const queued = jobs.filter((j) => j.status === 'queued');
      return {
        running: activeJobs.length,
        queued: queued.length,
        concurrency,
        titles: activeJobs.map((j) => j.title).slice(0, 5),
      };
    },
  };
}
