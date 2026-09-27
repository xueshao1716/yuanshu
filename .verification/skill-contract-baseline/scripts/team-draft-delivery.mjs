import { reviewPath, reviewAtomicWrite } from '../engine/review-file-safety.mjs';

export function hasNoUnresolved(result) {
  return Array.isArray(result?.unresolved) && result.unresolved.length === 0;
}

// A successful submission means only awaiting human acceptance, never delivery.
export async function stageTeamDraft({ wsRoot, runId, content, eligible, submit }) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(runId) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(runId)) throw new Error('Invalid runId');
  if (typeof content !== 'string' || !content.trim()) throw new Error('Empty draft');
  const base = `工程/多AI角色扮演系统/runs/${runId}`;
  const draft = `${base}/草稿/终稿.md`;
  const target = `${base}/交付/终稿.md`;
  reviewPath(wsRoot, target);
  reviewAtomicWrite(reviewPath(wsRoot, draft), content);
  const result = { draft, target };
  if (eligible !== true) return { ...result, status: 'quality_failed' };
  try {
    const response = await submit({ target, content, by: '天团', note: '模型审阅后的草稿，待人工验收；不代表真实生成或外部发布已验证' });
    if (response?.ok !== true || typeof response.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(response.id)) throw new Error('Submission failed');
    return { ...result, status: 'awaiting_acceptance', proposalId: response.id };
  } catch {
    return { ...result, status: 'submission_failed', error: '草稿已保存，但未进入验收队列；未交付' };
  }
}
