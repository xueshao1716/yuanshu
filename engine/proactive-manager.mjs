// ===== proactive-manager.mjs —— 主动管理性（2026-10-27）=====
//
// 用户看中的不是成本数字，是 **Cue 那种"不用你开口就在盯"的主动管理**。
//
// 元枢原来只有"事件发生 → 汇报"（被动触发），缺的是三样：
//   ① **在盯的东西**（watch）：用户说一句"盯住 X"，它就该一直盯着；
//   ② **未闭环的事**（open loop）：作业失败、卡住、汇报没人认领、补丁没人合并——这些要有人追；
//   ③ **追的节奏**：不能每轮都喊（烦），也不能喊一次就算了（漏）。
//
// 所以这一层是「账本 + 节奏」：
//   · 账本：每个 open loop 记 attempts / lastActionAt / lastAction；
//   · 节奏：同一件事 6 小时内最多催 1 次，最多催 2 次，之后升级一次，再之后闭嘴（等用户）。
//   · 动作：nudge（高优先级汇报）/ escalate（标红）/ retry（默认关闭，只有配置显式打开才做）。
import fs from "node:fs";
import path from "node:path";
import { collectJobs, enqueueReport, readReports } from "./job-state.mjs";

export const STATE_FILE = path.join("记忆", "运行时", "主动管理.json");
export const NUDGE_COOLDOWN_MS = 6 * 3600 * 1000;
export const MAX_NUDGES = 2;
export const ESCALATE_AFTER = 24 * 3600 * 1000;
// 2026-10-27：真机第一次扫就刷了 48 条（全是两三天前的测试作业与旧汇报）。
// 教训：主动管理必须"只追新鲜的"，否则就是噪音制造机。
export const JOB_MAX_AGE_MS = 24 * 3600 * 1000;      // 作业失败超过一天就不再追
export const REPORT_MAX_AGE_MS = 24 * 3600 * 1000;   // 汇报积压超过一天就不再追（42 小时的旧汇报没人想听）
export const MAX_PER_SWEEP = 3;                      // 每次最多催 3 条，其余下一轮

const fileOf = (ws) => path.join(String(ws || "."), STATE_FILE);

export function readState(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), "utf8"));
    if (raw && typeof raw === "object") {
      return { v: 1, updatedAt: 0, config: {}, watches: [], loops: {}, actions: [], ...raw };
    }
  } catch {}
  return { v: 1, updatedAt: 0, config: {}, watches: [], loops: {}, actions: [] };
}

function writeState(wsRoot, data) {
  const p = fileOf(wsRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...data, v: 1, updatedAt: Date.now() }, null, 2), "utf8");
  return data;
}

export function readConfig(wsRoot) {
  const s = readState(wsRoot);
  return {
    autoRetryFailedJobs: s.config?.autoRetryFailedJobs === true,
    nudgeCooldownMs: Number(s.config?.nudgeCooldownMs) > 0 ? Number(s.config.nudgeCooldownMs) : NUDGE_COOLDOWN_MS,
    maxNudges: Number(s.config?.maxNudges) > 0 ? Number(s.config.maxNudges) : MAX_NUDGES,
  };
}

/** 让元枢盯一件事。keywords 为空时用 title 分词。 */
export function addWatch({ wsRoot, title, keywords = [], now = Date.now() } = {}) {
  const name = String(title || "").trim();
  if (!name) return { ok: false, error: "标题不能为空" };
  const state = readState(wsRoot);
  const id = `w-${Buffer.from(name).toString("hex").slice(0, 8)}`;
  if (state.watches.some((w) => w.id === id)) return { ok: true, id, existed: true };
  const words = keywords.length
    ? keywords
    : [...new Set(name.split(/[\s，,。;；:：/]+/).filter((x) => x.length >= 2))];
  state.watches.push({ id, title: name, keywords: words.slice(0, 8), createdAt: now, status: "watching", lastHitAt: 0 });
  writeState(wsRoot, state);
  return { ok: true, id };
}

export function stopWatch({ wsRoot, id } = {}) {
  const state = readState(wsRoot);
  const w = state.watches.find((x) => x.id === id);
  if (!w) return { ok: false, error: "没有这项" };
  w.status = "paused";
  writeState(wsRoot, state);
  return { ok: true };
}

/**
 * 把"该追的事"整理成 open loops（纯计算，不改状态）。
 * @returns {Array<{key,kind,title,detail,severity,payload}>}
 */
export function collectOpenLoops({ wsRoot, detached = [], runs = [], docChanges = [], patches = {}, now = Date.now() } = {}) {
  const loops = [];

  // ① 失败 / 卡住的作业
  const jobMaxAge = JOB_MAX_AGE_MS;
  for (const j of collectJobs({ wsRoot, detached, runs, now })) {
    // 太旧的失败不再追（否则一启动就把历史垃圾全翻出来）
    if (now - (Number(j.updatedAt || j.startedAt) || now) > jobMaxAge) continue;
    if (j.state === "failed") {
      loops.push({
        key: `job:${j.id}`, kind: "job-failed", severity: "high",
        title: `作业「${j.label}」失败了`, detail: `${j.step}${j.error ? `（${j.error}）` : ""}`,
        payload: { id: j.id },
      });
    } else if (j.state === "stalled") {
      loops.push({
        key: `job:${j.id}`, kind: "job-stalled", severity: "normal",
        title: `作业「${j.label}」像是卡住了`, detail: `超过 ${Math.round((now - (j.updatedAt || now)) / 60000)} 分钟没有新输出`,
        payload: { id: j.id },
      });
    }
  }

  // ② 汇报了但没人认领（超过 6 小时）
  for (const r of readReports(wsRoot) || []) {
    const at = Number(r.at) || 0;
    if (r.acked || !at || now - at < 6 * 3600 * 1000) continue;
    if (now - at > REPORT_MAX_AGE_MS) continue;
    // 2026-10-27：自己催出来的汇报不进这个循环，否则每催一次就多一条"没人认领"，会自我放大
    if (r.kind === 'proactive') continue;
    loops.push({
      key: `report:${r.id}`, kind: "report-unacked", severity: "normal",
      title: `「${r.label || r.id}」做完 ${Math.round((now - at) / 3600000)} 小时了还没人看`,
      detail: `${r.state || ""} ${r.step || ""}`.trim(),
      payload: { id: r.id },
    });
  }

  // ③ 补丁躺太久
  for (const [branch, info] of Object.entries(patches || {})) {
    if (info?.state !== "awaiting_review" && info?.state !== "stale") continue;
    const ageDays = Number(info.ageDays) || 0;
    if (ageDays < 2) continue;
    loops.push({
      key: `patch:${branch}`, kind: "patch-pending", severity: ageDays > 5 ? "high" : "normal",
      title: `补丁 ${branch} 已经躺了 ${Math.round(ageDays)} 天`,
      detail: `${info.files || 0} 个文件，还没合并也没丢弃`,
      payload: { branch },
    });
  }

  // ④ 在盯的东西命中了变化
  const state = readState(wsRoot);
  const watching = (state.watches || []).filter((w) => w.status === "watching");
  if (watching.length && docChanges.length) {
    for (const w of watching) {
      const hit = docChanges.find((c) => (w.keywords || []).some((k) => String(c.path || "").toLowerCase().includes(String(k).toLowerCase())));
      if (!hit) continue;
      loops.push({
        key: `watch:${w.id}`, kind: "watch-hit", severity: "normal",
        title: `你让我盯的「${w.title}」有新变化`,
        detail: `${hit.path}（${new Date(hit.at || now).toISOString().slice(0, 16)}）`,
        payload: { id: w.id },
      });
    }
  }

  return loops;
}

/**
 * 追一轮：决定谁该催、谁该升级、谁该闭嘴，并把动作记进账本。
 * @returns {{nudged:Array, escalated:Array, skipped:number, silent:number}}
 */
export function sweepProactive({ wsRoot, detached = [], runs = [], docChanges = [], patches = {}, now = Date.now(), push = true } = {}) {
  const state = readState(wsRoot);
  const cfg = readConfig(wsRoot);
  const loops = collectOpenLoops({ wsRoot, detached, runs, docChanges, patches, now });
  // 第一次跑只建基线：把现有的事儿记下来但不催（否则等于把历史垃圾一次性倒给用户）
  if (!state.baselineAt) {
    // 2026-10-27：基线轮**不追历史**——旧账记一笔就闭环。
    // 否则第一次启动会把两天前的测试作业一条条催给用户，纯噪音。
    for (const loop of loops) {
      state.loops[loop.key] = {
        firstSeenAt: now, attempts: 0, lastActionAt: now, lastAction: "baseline",
        status: "done", closedAt: now, kind: loop.kind, title: loop.title,
      };
    }
    state.baselineAt = now;
    writeState(wsRoot, state);
    return { baseline: true, nudged: [], escalated: [], skipped: 0, silent: 0, total: loops.length };
  }

  const nudged = [];
  const escalated = [];
  let skipped = 0;
  let silent = 0;

  for (const loop of loops) {
    // 每轮最多催 MAX_PER_SWEEP 条，其余留到下一轮（宁可慢，不要刷屏）
    if (nudged.length + escalated.length >= MAX_PER_SWEEP) { skipped += 1; continue }
    const rec = state.loops[loop.key] || { firstSeenAt: now, attempts: 0, lastActionAt: 0, lastAction: "", status: "open" };
    const since = now - (Number(rec.lastActionAt) || 0);

    // 基线里闭环过的旧账：即使还没消失，也不再追
    if (rec.lastAction === "baseline" && rec.status === "done") { silent += 1; continue }
    // 已经催过两次、且升级过 → 闭嘴（等人）
    if ((rec.attempts || 0) >= cfg.maxNudges && rec.lastAction === "escalate") { silent += 1; continue }
    // 冷却中 → 跳过
    if (rec.lastAction && since < cfg.nudgeCooldownMs) { skipped += 1; continue }

    const action = (rec.attempts || 0) >= cfg.maxNudges || (now - (rec.firstSeenAt || now)) > ESCALATE_AFTER
      ? "escalate"
      : "nudge";

    rec.status = action === "escalate" ? "escalated" : "nudged";
    rec.attempts = (rec.attempts || 0) + 1;
    rec.lastActionAt = now;
    rec.lastAction = action;
    rec.kind = loop.kind;
    rec.title = loop.title;
    state.loops[loop.key] = rec;

    if (action === "nudge") nudged.push(loop);
    else escalated.push(loop);

    if (push) {
      try {
        enqueueReport(wsRoot, {
          id: `proactive-${loop.key.replace(/[^\w:-]/g, "_")}-${Math.floor(now / 60000)}`,
          kind: "proactive",
          label: loop.title,
          state: action === "escalate" ? "needs_decision" : "waiting",
          step: loop.detail,
          priority: loop.severity === "high" ? "high" : "normal",
          at: now,
        });
      } catch {}
    }
  }

  // 动作日志（最近 50 条）
  const actions = [
    ...nudged.map((l) => ({ at: now, action: "nudge", key: l.key, title: l.title })),
    ...escalated.map((l) => ({ at: now, action: "escalate", key: l.key, title: l.title })),
    ...(state.actions || []),
  ].slice(0, 50);
  state.actions = actions;

  // 已经不存在的事情 → 闭环
  const liveKeys = new Set(loops.map((l) => l.key));
  for (const key of Object.keys(state.loops)) {
    if (!liveKeys.has(key) && state.loops[key].status !== "done") {
      state.loops[key].status = "done";
      state.loops[key].closedAt = now;
    }
  }

  writeState(wsRoot, state);
  return { baseline: false, nudged, escalated, skipped, silent, total: loops.length };
}

/** 环境事实一行：只说"我在盯 N 件事"，细节走面板。 */
export function proactiveLine(wsRoot) {
  const state = readState(wsRoot);
  const open = Object.entries(state.loops || {}).filter(([, v]) => v.status === "nudged" || v.status === "escalated");
  const watching = (state.watches || []).filter((w) => w.status === "watching");
  if (!open.length && !watching.length) return "";
  const parts = [];
  if (watching.length) parts.push(`盯着 ${watching.length} 件事`);
  if (open.length) parts.push(`有 ${open.length} 件在跟进`);
  const head = open.slice(0, 2).map(([, v]) => v.title).join("；");
  return `【主动管理】${parts.join("，")}${head ? `：${head}` : ""}——细节在「主动管理」里。`;
}

export function listProactive(wsRoot) {
  const state = readState(wsRoot);
  return {
    watches: state.watches || [],
    loops: Object.entries(state.loops || {})
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => (b.lastActionAt || 0) - (a.lastActionAt || 0)),
    actions: (state.actions || []).slice(0, 20),
    updatedAt: state.updatedAt || 0,
  };
}
