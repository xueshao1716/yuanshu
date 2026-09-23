// One invocation retains its history, effect keys, loop guards and abort signal.
export const MAX_AUTOMATIC_EXECUTION_MS = 30 * 60 * 1000;

export function continuationLimits(opts, batchSize, turn = 0) {
  const automatic = !opts.imageIntent && opts.tools !== false
    && (opts.autoContinueTools === true || (opts.autoContinueTools !== false && opts.maxTurns == null));
  // A user-requested resume receives a new bounded budget, while absolute
  // turn numbers continue for the effects ledger (never reset to zero).
  const requestedMs = Number(opts.executionBudgetMs);
  const budgetMs = Number.isFinite(requestedMs) && requestedMs > 0
    ? Math.min(requestedMs, MAX_AUTOMATIC_EXECUTION_MS) : MAX_AUTOMATIC_EXECUTION_MS;
  // Time is checked at safe round boundaries, never halfway through a write.
  return { automatic, budgetMs, deadline: Date.now() + budgetMs, startTurn: turn, limit: turn + batchSize };
}

export function truncationRecoveryPrompt(budget, attempt) {
  const chars = Math.max(128, Math.min(4000, Math.floor(budget / (attempt + 1))));
  return `上一轮输出未完整结束，半截工具参数没有执行。完整工具的结果已保留，禁止重做已成功的操作。无需用户回复“分块写”，请自动接续：纯文本从断点继续、不重复已输出内容；文件每块不超过 ${chars} 字符，先检查已有内容，新文件首块 write，后续 write + append:true。长脚本也分块建立后执行。批量采集由脚本分页、限速、断点续传并直接落盘，只回传数量、路径和校验摘要，不要把全量数据放进对话或工具参数。`;
}

export function toolTurnLimitResult(turn, history, usedModel, streamed, text, reason = 'tool_turn_limit') {
  const cause = reason === 'execution_budget' ? '本次自动执行时间预算已用完'
    : reason === 'progress_boundary' ? '本批次末轮未确认工具进展'
      : `本次已达到指定的 ${turn} 轮执行预算`;
  return { paused: true, pauseReason: reason,
    message: `${cause}，任务已暂停，尚未完成。已保留工具结果和检查点，点击“继续任务”可从断点接续；批量工作请优先使用可断点续传的脚本。`,
    partial: true, history, usedModel, streamed, text };
}

// Compatibility view only: preserve the old failure and event history on disk.
export function withLegacyContinuation(run) {
  const snapshot = run?.checkpoint?.historySnapshot;
  if (run?.status === 'failed' && snapshot?.v === 1 && Array.isArray(snapshot.messages) && snapshot.messages.length > 0
      && /本轮已达到 \d+ 轮工具调用的执行上限/.test(String(run.error || ''))) {
    return { ...run, resumeAvailable: true };
  }
  return run;
}

// Background consumers have no interactive resume UI. Never parse partial work
// as a completed action or an independent verification verdict.
export function completedTaskText(result) {
  if (result?.paused) throw Object.assign(new Error('执行预算已用完，后台任务尚未完成。'), { code: 'execution_paused' });
  if (result?.aborted) throw new Error('后台任务已停止，尚未完成。');
  if (result?.error) throw new Error(String(result.error));
  return result?.text || result?.content || '';
}
