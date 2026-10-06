// 时间引擎 v2：任务中心（2026-08-25，MyAgents 任务系统路线）
// 升级点：
//   ① 状态机：active（调度中）/ paused（暂停）/ done（一次性完成）/ archived（归档）——只调度 active
//   ② queueId 执行身份：每次执行一个唯一 ID；stop 拿到业务确认才算成功，失败保留 stopped 投影
//   ③ 运行历史：每任务最近 20 条 {queueId, startedAt, durationMs, status, result}——追踪复盘的基础
//   ④ 原子持久化；旧格式自动迁移（无 state 的任务补 active）
// 兼容：register/remove/list/check/_isDue 签名不变，server 与前端平滑升级
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { atomicWriteJson } from "./atomic-io.mjs";

const DEFAULT_TASKS_FILE = path.join(os.homedir(), ".pi", "agent", "time-tasks.json");
const CHECK_MS = 20_000;
const HISTORY_CAP = 20;
const RESULT_CAP = 16000; // 反思/长输出要能复盘，200 字会把正文裁没

export function createTimeEngine(runner, opts = {}) {
  const taskFile = opts.file || DEFAULT_TASKS_FILE;
  const onTaskDone = opts.onTaskDone || null; // 技能沉淀钩子（09-03）：任务成功完成后 fire-and-forget，不阻塞
  let tasks = [];
  let timer = null;
  const running = new Map(); // taskId → queueId（执行身份）
  const controllers = new Map(); // taskId → AbortController（真正取消 runner）
  const stopRequested = new Set();

  function migrate(t) {
    if (!t.state) t.state = "active";
    if (!Array.isArray(t.history)) t.history = [];
    return t;
  }
  function load() {
    try {
      if (fs.existsSync(taskFile)) {
        const d = JSON.parse(fs.readFileSync(taskFile, "utf8"));
        tasks = (Array.isArray(d.tasks) ? d.tasks : []).map(migrate);
      }
    } catch { tasks = []; }
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(taskFile), { recursive: true });
      atomicWriteJson(taskFile, { tasks, updatedAt: new Date().toISOString() });
    } catch {}
  }

  // 注册：type=once(需 date+at) / daily(at) / weekly(day+at, 周一=1)
  function register({ type = "daily", at = "09:00", day, date, prompt = "", label = "" }) {
    if (!prompt) return { error: "缺少任务描述 prompt" };
    if (!/^\d{2}:\d{2}$/.test(at)) return { error: "at 格式应为 HH:MM（如 09:00）" };
    const t = { id: randomUUID().slice(0, 8), type, at, day: day ?? null, date: date ?? null, prompt, label, created: new Date().toISOString(), lastRun: null, runs: 0, state: "active", history: [] };
    if (type === "once" && !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return { error: "once 任务需要 date（YYYY-MM-DD）" };
    if (type === "weekly" && !(day >= 1 && day <= 7)) return { error: "weekly 任务需要 day（1-7，周一=1）" };
    tasks.push(t); save();
    return { id: t.id };
  }
  function remove(id) {
    const before = tasks.length;
    tasks = tasks.filter(t => t.id !== id);
    const changed = tasks.length !== before;
    if (changed) { running.delete(id); save(); }
    return { removed: changed };
  }
  function list() { return tasks.map(t => ({ ...t, running: running.has(t.id) })); }
  function find(id) { return tasks.find(t => t.id === id); }

  // ── 状态机：active ⇄ paused；active/done → archived；once 跑完自动 done ──
  function setState(id, state) {
    const t = find(id);
    if (!t) return { error: "任务不存在" };
    const allowed = { active: ["paused", "archived"], paused: ["active", "archived"], done: ["archived"], archived: [] };
    if (!(allowed[t.state] || []).includes(state)) return { error: `不允许 ${t.state} → ${state}` };
    t.state = state; save();
    return { ok: true, state };
  }
  function pause(id) { return setState(id, "paused"); }
  function resume(id) { return setState(id, "active"); }
  function archive(id) { return setState(id, "archived"); }

  // ── 执行身份与运行历史 ──
  function recordRun(t, queueId, startedAt, status, result) {
    t.history = t.history || [];
    t.history.unshift({ queueId, startedAt, durationMs: Date.now() - startedAt, status, result: String(result || "").slice(0, RESULT_CAP) });
    if (t.history.length > HISTORY_CAP) t.history.length = HISTORY_CAP;
  }

  // 执行一次（调度到期 or 手动 runNow 共用）；返回 queueId
  async function execute(t, trigger = "schedule") {
    const queueId = randomUUID().slice(0, 12);
    const startedAt = Date.now();
    const controller = new AbortController();
    running.set(t.id, queueId);
    controllers.set(t.id, controller);
    stopRequested.delete(t.id);
    // 开跑前先落盘：执行中进程崩溃时 lastRun 写不进去，补跑判定靠它避免重启后反复重跑同一天。
    t.lastStart = new Date(startedAt).toISOString();
    save();
    let status = "ok", result = "";
    try {
      const out = runner ? await runner({ ...t, firedAt: new Date().toISOString(), queueId, trigger }, controller.signal) : null;
      result = typeof out === "string" ? out : (out?.text ?? out?.result ?? "");
    } catch (e) {
      status = "error";
      result = String(e?.message || e).slice(0, 200);
      console.log(`[time-engine] 任务 ${t.id} 执行失败: ${result.slice(0, 150)}`);
    } finally {
      // stop 已把该 queueId 从 running 移除 → 本次结果标记 stopped（业务确认语义）
      const confirmed = running.get(t.id) === queueId;
      if (confirmed) running.delete(t.id);
      controllers.delete(t.id);
      if (stopRequested.delete(t.id) || controller.signal.aborted) status = "stopped";
      else if (!confirmed) status = status === "error" ? "error" : "stopped";
      t.lastRun = new Date(startedAt).toISOString();
      t.runs = (t.runs || 0) + 1;
      recordRun(t, queueId, startedAt, status, result);
      if (t.type === "once" && t.state === "active") t.state = "done"; // 一次性完成自动入档
      save();
      // 技能自主沉淀钩子：任务成功且有实质结果 → 异步评估是否值得沉淀为技能（Hermes 闭环）
      if (onTaskDone && status === "ok" && result && result.length >= 120) {
        try { Promise.resolve(onTaskDone({ label: t.label || t.prompt?.slice(0, 60), result: String(result).slice(0, 4000), trigger: "time-task", taskId: t.id })).catch(() => {}); } catch {}
      }
    }
    return { queueId, status };
  }

  // 手动立即执行（不受 active 校验限制，但 paused/archived 不自动跑）
  async function runNow(id) {
    const t = find(id);
    if (!t) return { error: "任务不存在" };
    if (running.has(t.id)) return { error: "任务正在执行中", queueId: running.get(t.id) };
    const { queueId } = await execute(t, "manual");
    return { ok: true, queueId };
  }

  // stopRun：请求停止当前执行。拿到业务确认（running 移除该 queueId）才算成功；
  // 实际的 Promise 中断由 runner 层配合（本层负责身份核销与 stopped 投影）
  // ⚠️ 不能叫 stop——与定时器 stop() 撞名会被函数声明覆盖
  function stopRun(id) {
    const qid = running.get(id);
    if (!qid) return { stopped: false, reason: "未在执行" };
    stopRequested.add(id);
    controllers.get(id)?.abort();
    const t = find(id);
    if (t) { recordRun(t, qid, Date.now(), "stop_requested", ""); save(); }
    return { stopped: false, stopping: true, queueId: qid };
  }

  // 判断任务在 now 是否到期（含防重复）
  const localYmd = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  // 到点之后当天都算到期（不再要求恰好在那一分钟）：服务在 at 那分钟宕机或重启，
  // 起来后当天补跑一次。当天新建/在 at 之后才建的任务不补跑，免得一建就触发。
  function isDue(t, now) {
    if (t.state !== "active") return false;
    const [hh, mm] = String(t.at || "").split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
    const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
    if (now < slot) return false;
    const today = localYmd(now);
    const created = t.created ? new Date(t.created) : null;
    if (created && localYmd(created) === today && created > slot) return false;
    const stamps = [t.lastRun, t.lastStart].filter(Boolean).map(v => new Date(v)).filter(d => !Number.isNaN(d.getTime()));
    const last = stamps.length ? new Date(Math.max(...stamps.map(d => d.getTime()))) : null;
    if (t.type === "once") {
      if (t.date !== today) return false;
      if (last) return false;
      return true;
    }
    if (t.type === "daily") {
      if (last && localYmd(last) === today) return false;
      return true;
    }
    if (t.type === "weekly") {
      const dow = now.getDay() || 7;
      if (dow !== t.day) return false;
      if (last && localYmd(last) === today) return false;
      return true;
    }
    return false;
  }

  async function check() {
    const now = new Date();
    for (const t of [...tasks]) {
      if (running.has(t.id)) continue;
      if (isDue(t, now)) await execute(t, "schedule");
    }
    // 过期 once 清理仅针对已 done/archived 的（active 的保留补跑权）
    const today = localYmd(now);
    const before = tasks.length;
    tasks = tasks.filter(t => !(t.type === "once" && t.date < today && t.state !== "active"));
    if (tasks.length !== before) save();
  }

  function start() {
    load();
    if (timer) return;
    console.log(`[time-engine] 任务中心已启动（${tasks.filter(t => t.state === "active").length} 个调度中 / 共 ${tasks.length} 个，每 ${CHECK_MS / 1000}s 检查）`);
    timer = setInterval(check, CHECK_MS);
    check(); // 启动立即检查一次（补跑重启期间到点的任务）
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, stopRun, register, remove, list, check, pause, resume, archive, setState, runNow, find, _isDue: isDue, _file: taskFile };
}

// 时间感知文本：统一由 yuanshu-seams 的 promptTimeText 产出（含"过了多久"）。
// 这里原本还有一个 nowContext()，与它是重复实现（三份时间格式化里的两份），
// 且**全仓零调用者**，2026-09-14 删除——避免第三套时钟各说各话。
