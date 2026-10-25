// 知识摄入这个周期性 worker 的状态（2026-10-26）
// 背景：它 10/22 起停摆（死进程留下的 background-admission 租约），但没有任何地方看得见——
// 直到用户问"知识板块怎么好久没变了"。这里把它变成一个**可被 job_status 报出来的作业**。
import fs from "node:fs";
import path from "node:path";

const KDIR = path.join("记忆", "知识");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function newestEntryAt(wsRoot) {
  try {
    const dir = path.join(String(wsRoot), KDIR, "entries");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    let newest = 0;
    for (const f of files) {
      const t = fs.statSync(path.join(dir, f)).mtimeMs;
      if (t > newest) newest = t;
    }
    return newest;
  } catch { return 0; }
}

/**
 * 把知识摄入收成一条作业：
 *   - 租约被死进程占着 → failed（说清是谁占的、什么时候占的）
 *   - 队列积压且很久没产出 → stalled（这正是用户看到的现象）
 *   - 正常 → running/done
 */
export function knowledgeJob({ wsRoot, now = Date.now(), stallMs = 24 * 3600 * 1000 } = {}) {
  const root = String(wsRoot || ".");
  const state = readJson(path.join(root, KDIR, "state.json")) || {};
  const adm = readJson(path.join(root, KDIR, "background-admission.json")) || {};
  const jobs = Array.isArray(state.jobs) ? state.jobs : Object.values(state.jobs || {});
  const queued = jobs.length;
  const lastEntryAt = newestEntryAt(root);
  const slot = adm.slot || null;

  let stateName = "running";
  let step = `队列 ${queued}，最近产出 ${lastEntryAt ? new Date(lastEntryAt).toISOString().slice(0, 16) : "从未"}`;
  let error = "";

  if (slot) {
    const ageMin = Math.round((now - Number(slot.at || 0)) / 60000);
    stateName = "failed";
    error = `后台租约被 pid ${slot.pid} 占用（${ageMin} 分钟前）`;
    step = `租约：${slot.consumer} · pid ${slot.pid}`;
  } else if (queued > 0 && lastEntryAt && now - lastEntryAt > stallMs) {
    stateName = "stalled";
    step = `队列 ${queued} 条，但已 ${Math.round((now - lastEntryAt) / 3600000)} 小时没有新条目`;
  } else if (!queued && (!lastEntryAt || now - lastEntryAt > stallMs)) {
    stateName = "stalled";
    step = `既没队列也没新产出（最近 ${lastEntryAt ? new Date(lastEntryAt).toISOString().slice(0, 10) : "从未"}）`;
  }

  return {
    id: "knowledge:intake",
    kind: "knowledge",
    label: "知识摄入（后台整理）",
    state: stateName,
    step: step.slice(0, 90),
    startedAt: lastEntryAt || null,
    updatedAt: lastEntryAt || now,
    elapsedMs: lastEntryAt ? now - lastEntryAt : 0,
    error: error.slice(0, 120),
  };
}
