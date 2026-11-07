// engine/subagent-background.mjs —— 子代理后台化 + 跑完回传 + 可续聊（2026-11-07）
//
// 原来 `delegate_task` 是同步的：主循环派活 → 干等 → 拿结论。等的那几分钟里
// 主循环什么也做不了，而真正的问题往往是"等回来才发现它跑偏了"。
// 这一层补的四步闭环：
//   ① 后台：start() 立刻返回 { subagentId, status:'running', startedAt }，执行扔进 job-pool；
//   ② 回传：终态（done/failed/cancelled/interrupted）写进 agent-mailbox，父会话下一轮能看到；
//   ③ 续聊：continueSubagent() 对已结束的子代理再发一条，保留原任务/上下文/结论；
//   ④ 可查：list() 把登记表 + traces + mailbox 未读合成一张表。
//
// 两条硬约束（用户明确要求）：
//   · **不自造调度器**：执行一律 pool.submit（生产传 job-pool，续聊也走同一条通道）；
//   · **状态机显式**：所有状态改动都过 subagent-state 的 canTransition/assertTransition，
//     非法转移直接报错而不是"顺手改掉"。
import { assertTransition, buildReceipt, filterSubagents, statusLabel, shouldPushReceipt } from "./subagent-state.mjs";
import { KEEP_RECORDS, readSubagentRegistry, writeSubagentRegistry } from "./subagent-registry.mjs";
import { deliverSubagentReceipts, postSubagentReceipt, subagentUnreadCount, unreadBySubagent } from "./subagent-receipts.mjs";

export const BACKGROUND_TIMEOUT_MS = 15 * 60_000;   // 后台不占单轮预算，允许比同步模式（180s）长得多
export const MIN_PUSH_MS = 20_000;                  // 太短的成功不打扰人（与 notifier 的 LONG_RUN_MS 同向）
export const DEFAULT_PARENT_AGENT = "小语";
const MAX_STORED_RESULT = 3000;
const MAX_MEMORY_RECORDS = 200;

const iso = (ms) => new Date(ms).toISOString();
const clip = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

/** traces 的状态词是 completed/failed/...，与这里的状态机对齐一下。 */
export function mapTraceStatus(status) {
  const value = String(status || "");
  if (value === "completed") return "done";
  return ["queued", "running", "done", "failed", "cancelled", "interrupted"].includes(value) ? value : "failed";
}

/**
 * @param {object} options
 * @param {string} options.wsRoot 工作区（登记表与 mailbox 都在它下面）
 * @param {object} options.pool job-pool 实例（**必须注入**，这里不 new 调度器）
 * @param {Function} options.spawn 真执行器：生产是 subagent.spawnSubagent，测试用假执行器
 * @param {Function} [options.push] 推给人（notifier）；调用前已过 shouldPushReceipt + budgetGate
 * @param {Function} [options.budgetGate] 主动预算闸门，返回 {allowed, reason}
 * @param {Function} [options.traceHistory] ({limit}) => Promise<traces>，列表要合并 traces
 * @param {Function} [options.now]
 */
export function createSubagentBackground({
  wsRoot,
  pool,
  spawn,
  push = null,
  budgetGate = null,
  traceHistory = null,
  now = () => Date.now(),
  minPushMs = MIN_PUSH_MS,
} = {}) {
  if (!pool || typeof pool.submit !== "function") throw new Error("后台子代理必须注入 job-pool（不许自造调度器）");
  if (typeof spawn !== "function") throw new Error("后台子代理必须注入 spawn 执行器");
  const root = String(wsRoot || ".");
  const records = new Map();
  const pendingPushes = new Set();
  let seq = 0;

  for (const row of readSubagentRegistry(root)) if (row?.id) records.set(row.id, row);
  recoverOrphans();

  // ── 记录读写 ──────────────────────────────────────────────
  function save(record) {
    records.set(record.id, record);
    // 内存也别无限长：超过上限就按"最近 N 条"瘦身（丢的是整条记录，不是字段）
    if (records.size > MAX_MEMORY_RECORDS) {
      const byId = new Map([...records.values()].map((row) => [row.id, row]));
      const kept = filterSubagents([...byId.values()], { limit: KEEP_RECORDS });
      records.clear();
      for (const row of kept) records.set(row.id, byId.get(row.id));
    }
    const out = writeSubagentRegistry(root, [...records.values()]);
    if (!out.ok) record.persistError = out.error || "落盘失败";
    return record;
  }

  function applyTransition(record, to) {
    assertTransition(record.status, to);   // 非法转移直接抛，调用方决定怎么报
    record.status = to;
    record.history = [...(Array.isArray(record.history) ? record.history : []), { at: now(), kind: to }].slice(-8);
    return record.status;
  }

  // 进程重启前还在跑的记录不可能还活着：统一落成 interrupted 并留回执，别让父会话永远等
  function recoverOrphans() {
    const orphans = [...records.values()].filter((record) => record.status === "running" || record.status === "queued");
    for (const record of orphans) {
      const at = now();
      record.status = "interrupted";
      record.endedAt = iso(at);
      record.durationMs = 0;
      record.errorCode = "interrupted";
      record.error = "宿主在子代理结束前重启，已恢复为中断（可以续聊接着干）";
      record.summary = record.error;
      record.history = [...(Array.isArray(record.history) ? record.history : []), { at, kind: "interrupted" }].slice(-8);
      const receipt = buildReceipt({ id: record.id, status: "interrupted", task: record.task, error: record.error, durationMs: 0, continueCount: record.continueCount });
      try { postSubagentReceipt({ wsRoot: root, record, receipt, at }); } catch { /* 回执失败不影响恢复 */ }
      save(record);
    }
    return orphans.length;
  }

  // ── 执行 ──────────────────────────────────────────────────
  function submitRun(record, { task, context, seed, timeoutMs }) {
    const job = pool.submit({ kind: "subagent", title: `子代理：${clip(task, 60)}` }, async (signal) => {
      if (record.status === "queued") applyTransition(record, "running");
      record.attempts = (Number(record.attempts) || 0) + 1;
      record.startedAt = record.startedAt || iso(now());
      save(record);
      const startedAt = now();
      let outcome;
      try {
        outcome = await spawn({
          task,
          context,
          seed,
          role: record.role,
          profile: record.profile,
          sessionId: record.parentSessionId,
          runId: record.parentRunId,
          model: record.model || null,
          timeoutMs,
          // 关键：这里的 signal 只来自 job-pool（用户取消），**不是**父轮次的 signal——
          // 父轮次结束不该带走后台任务，所以 start() 从不接收调用方的 abort signal。
          signal,
        });
      } catch (error) {
        outcome = { done: false, error: String(error?.message || error).slice(0, 800) };
      }
      return settle(record, outcome, startedAt);
    });
    record.jobId = job?.id || record.jobId || "";
    // job-pool 的 pump() 是同步跑的：有空槽时这里已经是 running，把状态如实写上，
    // 否则 start() 返回的 state 会永远慢一拍（说自己在排队，其实已经开跑）。
    const tracked = typeof pool.get === "function" ? pool.get(job?.id) : null;
    if (tracked?.status === "running" && record.status === "queued") {
      try { applyTransition(record, "running"); } catch { record.status = "running"; }
    }
    if (!record.startedAt && (tracked?.startedAt || tracked?.status === "running")) record.startedAt = tracked?.startedAt || iso(now());
    save(record);
    return job;
  }

  /** 收尾：状态 → 回传 → 推送。成功/失败/取消/中断都走这里（不许只在成功时通知）。 */
  function settle(record, outcome, startedAt) {
    const endedAt = now();
    const durationMs = Math.max(0, endedAt - startedAt);
    const cancelled = outcome?.cancelled === true;
    const completed = outcome?.done === true;
    const nextStatus = cancelled ? "cancelled" : completed ? "done" : "failed";
    const errorCode = String(outcome?.errorCode || (cancelled ? "cancelled" : completed ? "" : "upstream_error"));
    try { applyTransition(record, nextStatus); }
    catch { record.status = nextStatus; }   // 兜底：任何情况都不能把记录永远挂在 running
    record.endedAt = iso(endedAt);
    record.durationMs = durationMs;
    record.errorCode = errorCode;
    record.error = completed ? "" : String(outcome?.error || statusLabel(nextStatus, { errorCode })).slice(0, 800);
    record.summary = completed ? clip(outcome?.result, 160) || "（没有正文）" : clip(record.error, 160);
    record.lastResult = completed ? String(outcome?.result || "").slice(0, MAX_STORED_RESULT) : "";
    record.evidence = Array.isArray(outcome?.evidence) ? outcome.evidence.slice(0, 6).map((item) => String(item).slice(0, 300)) : [];
    record.traceId = String(outcome?.subagentRunId || record.traceId || "");
    writeReceipt(record, {
      status: record.status,
      result: String(outcome?.result || ""),
      error: record.error,
      errorCode,
      durationMs,
      at: endedAt,
    });
    return record.summary || clip(record.lastReceipt, 200);
  }

  function writeReceipt(record, { status, result = "", error = "", errorCode = "", durationMs = 0, at = now() }) {
    const receipt = buildReceipt({
      id: record.id,
      status,
      task: record.task,
      result,
      error,
      errorCode,
      evidence: record.evidence,
      durationMs,
      continueCount: record.continueCount,
    });
    record.lastReceipt = receipt.text.slice(0, 400);
    try {
      const posted = postSubagentReceipt({ wsRoot: root, record, receipt, at });
      record.lastReceiptId = posted.ok ? posted.id || "" : "";
      record.receiptError = posted.ok ? "" : String(posted.error || "");
    } catch (error_) {
      record.receiptError = String(error_?.message || error_).slice(0, 120);
    }
    save(record);
    schedulePush(receipt, record);
    return receipt;
  }

  // 推送不阻塞 job 槽位：跑完先让池子空出来，推送在后台自己完成（whenIdle 可等它）
  function schedulePush(receipt, record) {
    if (typeof push !== "function") return;
    const decision = shouldPushReceipt({ status: record.status, durationMs: record.durationMs, minMs: minPushMs });
    if (!decision.push) { record.push = decision.reason; save(record); return; }
    const task = (async () => {
      try {
        const gate = typeof budgetGate === "function" ? await budgetGate({ receipt, record }) : { allowed: true };
        if (gate && gate.allowed === false) { record.push = String(gate.reason || "budget"); save(record); return; }
        await push(receipt, record);
        record.push = "sent";
      } catch { record.push = "failed"; }
      save(record);
    })();
    pendingPushes.add(task);
    task.finally(() => pendingPushes.delete(task));
  }

  // ── 对外入口 ──────────────────────────────────────────────
  function failure(code, message, extra = {}) {
    return { ok: false, code, error: message, ...extra };
  }

  function findByOwner(subagentId, sessionId = "") {
    const record = records.get(String(subagentId || ""));
    if (!record) return { error: failure("subagent_not_found", `没有这个子代理：${clip(subagentId, 80) || "（空 id）"}`) };
    const owner = String(record.parentSessionId || "");
    if (sessionId && owner && String(sessionId) !== owner) {
      return { error: failure("not_your_subagent", `子代理 ${record.id} 属于会话 ${owner}，不是 ${String(sessionId).slice(0, 40)} 的`) };
    }
    return { record };
  }

  /** 对外返回的"已受理"形状：status 固定 running（不阻塞调用方），真实排队状态在 state/queued。 */
  function accepted(record, job) {
    return {
      ok: true,
      subagentId: record.id,
      status: "running",
      // acceptedAt = 受理时间（排队时用它，别拿上一轮的 createdAt 冒充"刚开始"）
      startedAt: record.startedAt || record.acceptedAt || record.createdAt,
      state: record.status,
      queued: record.status === "queued",
      jobId: job?.id || record.jobId || "",
      task: record.task,
      timeoutMs: record.timeoutMs || null,
    };
  }

  function start({ task, context = [], seed = [], role = "analyst", sessionId = "", runId = "", parentAgent = DEFAULT_PARENT_AGENT,
    model = null, profile = "research", timeoutMs = BACKGROUND_TIMEOUT_MS } = {}) {
    const text = String(task || "").trim();
    if (!text) return failure("invalid_input", "后台子代理需要非空 task");
    const at = now();
    seq += 1;
    const record = {
      id: `subagent-bg-${at.toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`,
      parentSessionId: String(sessionId || "").slice(0, 120),
      parentAgent: String(parentAgent || DEFAULT_PARENT_AGENT).slice(0, 40),
      parentRunId: String(runId || "").slice(0, 120),
      role: String(role || "analyst"),
      profile: String(profile || "research"),
      task: text.slice(0, 8000),
      context: Array.isArray(context) ? context.slice(0, 8).map((item) => String(item).slice(0, 2000)) : [],
      seed: Array.isArray(seed) ? seed.slice(-24).map((item) => ({ role: item?.role, content: String(item?.content || "").slice(0, 4000) })) : [],
      model: model ? { provider: model.provider, id: model.id } : null,
      status: "queued",
      attempts: 0,
      continueCount: 0,
      createdAt: iso(at),
      acceptedAt: iso(at),
      startedAt: "",
      endedAt: "",
      durationMs: 0,
      summary: "",
      lastResult: "",
      evidence: [],
      error: "",
      errorCode: "",
      traceId: "",
      jobId: "",
      cwd: process.cwd(),
      timeoutMs,
      history: [{ at, kind: "start" }],
    };
    save(record);
    const job = submitRun(record, { task: record.task, context: record.context, seed: record.seed, timeoutMs });
    return accepted(record, job);
  }

  /** 续聊用的种子：原任务 + 上一轮结论（保留它原有的上下文，不用重新交代一遍）。 */
  function continuationSeed(record) {
    const seed = [];
    if (record.task) seed.push({ role: "user", content: String(record.task).slice(0, 6000) });
    const prior = String(record.lastResult || "").slice(0, MAX_STORED_RESULT);
    if (prior) seed.push({ role: "assistant", content: prior });
    // 上一轮没跑成：把失败原因如实带过去，但别伪装成"它当时的回答"
    else if (record.summary) seed.push({ role: "user", content: `（上一轮没有结论：${String(record.summary).slice(0, 500)}）` });
    return seed;
  }

  function continueSubagent({ subagentId, message, sessionId = "", timeoutMs = BACKGROUND_TIMEOUT_MS } = {}) {
    const found = findByOwner(subagentId, sessionId);
    if (found.error) return found.error;
    const record = found.record;
    const text = String(message || "").trim();
    if (!text) return failure("invalid_message", "续聊需要非空 message");
    if (record.status === "cancelled") return failure("subagent_cancelled", `子代理 ${record.id} 已被取消，不能续聊；要接着做请重新派一个`);
    if (record.status === "queued" || record.status === "running") {
      return failure("subagent_busy", `子代理 ${record.id} 还在${statusLabel(record.status)}，等它结束再续聊`);
    }
    try { assertTransition(record.status, "queued"); }
    catch (error) { return failure(error.code || "illegal_transition", error.message); }
    const seed = continuationSeed(record);
    record.status = "queued";
    record.acceptedAt = iso(now());
    record.continueCount = (Number(record.continueCount) || 0) + 1;
    record.continueMessage = clip(text, 300);
    record.timeoutMs = timeoutMs;
    record.error = "";
    record.errorCode = "";
    record.endedAt = "";
    record.durationMs = 0;
    record.startedAt = "";
    record.history = [...(Array.isArray(record.history) ? record.history : []), { at: now(), kind: "continue", message: clip(text, 120) }].slice(-8);
    save(record);
    // 续聊复用同一条 run 通道（同一个 job-pool + 同一份 traces），只是多带一条消息
    const job = submitRun(record, { task: text, context: record.context || [], seed, timeoutMs });
    return accepted(record, job);
  }

  function cancel({ subagentId, sessionId = "" } = {}) {
    const found = findByOwner(subagentId, sessionId);
    if (found.error) return found.error;
    const record = found.record;
    if (record.status === "queued") {
      // 排队中的作业池子不会回调 run，必须在这里收尾，否则登记表永远挂在 queued
      try { pool.cancel(record.jobId); } catch { /* 池子说没有就算了，我们自己收尾 */ }
      try { applyTransition(record, "cancelled"); } catch { record.status = "cancelled"; }
      record.endedAt = iso(now());
      record.durationMs = 0;
      record.errorCode = "cancelled";
      record.error = "排队中被取消，没有开跑";
      record.summary = record.error;
      writeReceipt(record, { status: "cancelled", error: record.error, errorCode: "cancelled", durationMs: 0, at: now() });
      return { ok: true, subagentId: record.id, status: "cancelled", state: record.status };
    }
    if (record.status === "running") {
      const out = pool.cancel(record.jobId);
      if (out && out.ok === false) return failure("cancel_failed", `取消失败：${out.reason || "pool 拒绝"}`);
      return { ok: true, subagentId: record.id, status: "running", state: record.status, note: "已请求取消；收尾与回传在它退出时完成" };
    }
    return failure("illegal_transition", `子代理 ${record.id} 当前是「${statusLabel(record.status)}」，不能取消`);
  }

  function toListRow(record, unreadMap) {
    const parentSessionId = String(record.parentSessionId || "");
    return {
      id: record.id,
      source: "registry",
      parent: { sessionId: parentSessionId, agent: String(record.parentAgent || "") },
      parentSessionId,
      role: record.role,
      status: record.status,
      startedAt: record.startedAt || record.createdAt || "",
      endedAt: record.endedAt || "",
      durationMs: Number(record.durationMs) || 0,
      summary: String(record.summary || ""),
      unread: unreadMap.get(record.id) || 0,
      continueCount: Number(record.continueCount) || 0,
      task: String(record.task || ""),
      error: String(record.error || ""),
      traceId: String(record.traceId || ""),
      push: String(record.push || ""),
      queued: record.status === "queued",
    };
  }

  async function list({ status = "", sessionId = "", limit = 50 } = {}) {
    const unreadMap = unreadBySubagent(root);   // 只读一次盘，别按记录数反复读
    const rows = [...records.values()].map((record) => toListRow(record, unreadMap));
    // traces 里还有**同步**派出去的子代理（delegate_task）：一并列出来，标 source='trace'
    if (typeof traceHistory === "function") {
      try {
        const traces = await traceHistory({ limit: 100 });
        const known = new Set([...records.values()].map((record) => record.traceId).filter(Boolean));
        for (const trace of Array.isArray(traces) ? traces : []) {
          if (!trace?.runId || known.has(trace.runId)) continue;
          rows.push({
            id: trace.runId,
            source: "trace",
            parent: { sessionId: String(trace.sessionId || ""), agent: "" },
            parentSessionId: String(trace.sessionId || ""),
            role: trace.role || "analyst",
            status: mapTraceStatus(trace.status),
            startedAt: trace.startedAt || "",
            endedAt: trace.endedAt || "",
            durationMs: 0,
            summary: clip(trace.result || trace.error || "", 160),
            unread: 0,
            continueCount: 0,
            task: String(trace.task || ""),
            error: String(trace.error || ""),
            traceId: trace.runId,
            push: "",
            queued: false,
          });
        }
      } catch { /* traces 不可用不影响登记表本身 */ }
    }
    const items = filterSubagents(rows, { status, sessionId, limit });
    return {
      ok: true,
      total: items.length,
      running: items.filter((row) => row.status === "running" || row.status === "queued").length,
      items,
      updatedAt: iso(now()),
    };
  }

  /** 下一轮注入：把父会话的未读回执变成一条【系统】提示（内部已标记已读）。 */
  function deliverReceipts({ agent, limit } = {}) {
    return deliverSubagentReceipts({ wsRoot: root, agent, ...(limit ? { limit } : {}) });
  }

  function unreadFor(agent) {
    return subagentUnreadCount(root, agent);
  }

  /** 等所有在飞的推送落地（测试与关停前用；不影响 job 槽位）。 */
  async function whenIdle() {
    while (pendingPushes.size) await Promise.allSettled([...pendingPushes]);
  }

  return {
    start,
    continueSubagent,
    cancel,
    list,
    deliverReceipts,
    unreadFor,
    whenIdle,
    get: (id) => records.get(String(id || "")) || null,
    records: () => [...records.values()].map((record) => ({ ...record })),
    recoverOrphans,
  };
}
