// ===== internal-rounds.mjs —— 她自己发起的轮次也要有可追的身份（2026-11-07）=====
//
// 问题：看门狗能指认的只有「用户触发的 run」——run-store 有记录、runId 进审计行。
// 但下面三类是**她自己发起的**，以前既没有 run 记录，审计行里也没有 runId，
// 恰恰是最需要盯的：
//   ① 定时任务：time-engine 的 runner 直接 unifiedChat；
//   ② 后台子代理：job-pool + subagent-traces，id 空间与 run store 不同；
//   ③ 值班唤醒：jobPool.submit 里跑一轮 runTurn。
//
// 选择方案 A（复用 run-store），不另造台账，理由：
//   · 看门狗解析标题的路径已经是 titleOf(runId) → run-store；复用同一张表，
//     判断层/通知/接口不需要第二套查询，也不会出现"审计行有 id、索引里查不到名字"；
//   · 生命周期语义（running → completed/failed/stopped/interrupted）与用户 run 一致，
//     收尾逻辑只写一份；kind:'internal' 默认从用户列表/时间线过滤，行为不变。
//
// 这里不新造调度器，只做三件事：
//   ① 开始：建一条 kind:'internal' 的 run（默认不进用户 run 列表），
//      并把 id+title 以 round_start 写进动作审计（即使这一轮没调任何工具也留得下痕）；
//   ② 执行：用 AsyncLocalStorage 把 id/title/session 带到任意深的工具调用，
//      审计门自动写进每一条 before/after；
//   ③ 收尾：无论成功/失败/取消都写终态（run 记录 + round_end 审计行），且幂等。
import { randomUUID } from "node:crypto";

import { runWithRound } from "./round-context.mjs";
import { deriveRunTitle } from "./run-title.mjs";

// id 前缀刻意短且可区分：IM/通知里只显示前 8 位，rt-/rs-/rw- 一眼能看出轮次来源。
const KIND_PREFIX = { time: "rt", subagent: "rs", watch: "rw", misc: "ri" };
const KIND_SURFACE = { time: "cron", subagent: "subagent", watch: "watch", misc: "system" };
const KNOWN_KINDS = new Set(Object.keys(KIND_PREFIX));

function normalizeKind(kind) {
  const value = String(kind || "").trim();
  return KNOWN_KINDS.has(value) ? value : "misc";
}

function clip(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * @param {object} options
 * @param {object} options.runStore  必须注入 run-store（这里不自己建存储）
 * @param {object} [options.auditGate] 动作审计闸门；给了才写 round_start/round_end
 * @param {string} [options.ownerId]  进程实例 id（与用户 run 同一套归属判定）
 * @param {Function} [options.now]
 * @param {Function} [options.idFactory] (kind, ms) => id，测试用
 */
export function createInternalRounds({
  runStore,
  auditGate = null,
  ownerId = "",
  now = () => Date.now(),
  idFactory = null,
} = {}) {
  if (!runStore || typeof runStore.createInternal !== "function" || typeof runStore.finishInternal !== "function") {
    throw new Error("createInternalRounds 需要 run-store（createInternal/finishInternal）");
  }

  const makeId = (kind, at) => {
    if (typeof idFactory === "function") return String(idFactory(kind, at)).slice(0, 64);
    const rand = (typeof randomUUID === "function" ? randomUUID() : Math.random().toString(16)).replace(/-/g, "").slice(0, 4);
    return `${KIND_PREFIX[kind] || "ri"}-${Number(at).toString(36)}-${rand}`;
  };

  /**
   * 开始一轮。返回 null 表示观测层没建起来（写盘失败），调用方照旧执行、
   * 只是这一轮没有可追 id——观测坏了不该拦住任务本身。
   */
  function begin({ kind = "misc", refId = "", title = "", task = "", label = "", name = "", surface = "", meta = null } = {}) {
    const at = Number(now());
    const safeAt = Number.isFinite(at) && at > 0 ? at : Date.now();
    const roundKind = normalizeKind(kind);
    const roundId = makeId(roundKind, safeAt);
    const roundTitle = deriveRunTitle({
      title,
      task,
      label,
      name,
      surface: surface || KIND_SURFACE[roundKind],
      at: safeAt,
    });
    const metaText = {
      kind: roundKind,
      refId: String(refId || ""),
      title: roundTitle,
      task: clip(task, 300),
      label: clip(label, 120),
      name: clip(name, 120),
    };
    let run = null;
    try {
      run = runStore.createInternal({
        id: roundId,
        internalKind: roundKind,
        refId: String(refId || ""),
        title: roundTitle,
        surface: surface || KIND_SURFACE[roundKind],
        ownerId,
        internal: { ...metaText, ...(meta && typeof meta === "object" ? { meta } : {}) },
      });
    } catch (error) {
      try { console.warn(`[internal-round] 内部 run 写入失败（本轮照常执行）：${String(error?.message || error).slice(0, 120)}`); } catch {}
      return null;
    }

    const round = {
      runId: run.id,
      title: roundTitle,
      kind: roundKind,
      refId: String(refId || ""),
      sessionId: run.sessionId,
      createdAt: run.createdAt,
    };
    const audit = (phase, patch = {}) => {
      try { auditGate?.round?.({ phase, kind: roundKind, runId: run.id, title: roundTitle, session: run.sessionId, ...patch }); } catch {}
    };
    audit("round_start");

    let closed = false;
    const finish = (status = "completed", patch = {}) => {
      const finalStatus = String(status || "completed");
      if (closed) return runStore.get(run.id);
      closed = true;
      let updated = null;
      try {
        // stopped = 取消/被叫停（run-store 的终态词，与用户 run 的语义一致）
        updated = runStore.finishInternal(run.id, {
          status: finalStatus,
          error: patch?.error || "",
          errorCode: patch?.errorCode || "",
          resultPreview: patch?.resultPreview || "",
        });
      } catch (error) {
        try { console.warn(`[internal-round] 收尾写入失败 ${run.id}：${String(error?.message || error).slice(0, 120)}`); } catch {}
      }
      audit("round_end", {
        status: finalStatus,
        ok: finalStatus === "completed",
        error: String(patch?.error || ""),
      });
      return updated || run;
    };

    return {
      ...round,
      /** 在这一轮身份里跑执行器：工具审计经 AsyncLocalStorage 自动拿到 runId/title。 */
      enter(fn) {
        return runWithRound(round, fn);
      },
      finish,
      fail(error, patch = {}) {
        return finish("failed", { error: String(error?.message || error || ""), ...patch });
      },
      cancel(reason = "", patch = {}) {
        return finish("stopped", { error: String(reason || "已取消"), errorCode: "cancelled", ...patch });
      },
    };
  }

  return { begin };
}
