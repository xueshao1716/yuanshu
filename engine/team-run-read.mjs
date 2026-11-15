import { reviewStoragePath } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';
import { resolveTeamAcceptance } from './team-acceptance.mjs';

const VIDEO_SNAPSHOT = '工程/多AI角色扮演系统/team-run.json';
// general 天团走会话任务入口、没有 launcher。它单独落一条快照，避免覆盖视频流水线
// 用来确认"本次进程真的产出了结果"的 team-run.json；读取时按时间取最新一条。
const GENERAL_SNAPSHOT = '工程/多AI角色扮演系统/team-run-general.json';
const EMPTY_HINT = '通过天团启动入口提交视频脚本任务后，这里会显示运行记录。';

function readSnapshot(wsRoot, relative, limit) {
  const run = JSON.parse(readReviewBounded(reviewStoragePath(wsRoot, relative), limit).toString('utf8'));
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('Invalid snapshot');
  return run;
}

// 最新 general 快照是叠加层：读不出或格式不对就当作没有，不能把只读视图带崩。
function readGeneralSnapshot(wsRoot) {
  try {
    const run = readSnapshot(wsRoot, GENERAL_SNAPSHOT, 2_000_000);
    if (run.workflow !== 'team-general' || typeof run.runId !== 'string' || !run.runId) return null;
    return run;
  } catch { return null; }
}

function acceptanceOf(wsRoot, run) {
  const delivery = run?.delivery && typeof run.delivery === 'object' ? run.delivery : null;
  if (!delivery) return null;
  return resolveTeamAcceptance({ wsRoot, run: { runId: delivery.deliveryId, delivery } });
}

// Kept separate from server startup so the real read path can run in isolation.
export function createTeamRunRead({ wsRoot, json, getLaunch }) {
  return res => {
    try {
      const launch = getLaunch();
      let video = null;
      try { video = readSnapshot(wsRoot, VIDEO_SNAPSHOT, 16_000_000); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const general = readGeneralSnapshot(wsRoot);
      const generalIsLatest = general && (!video || String(general.createdAt || '') > String(video.createdAt || ''));
      if (generalIsLatest) {
        return json(res, 200, { ok: true, run: general, launch, snapshotKind: 'current',
          acceptance: acceptanceOf(wsRoot, general) });
      }
      if (!video) return json(res, 200, { ok: true, run: null, launch, snapshotKind: 'none', hint: EMPTY_HINT });
      const run = video;
      const snapshotKind = run.launchId && run.launchId === launch?.id && ['launching', 'running'].includes(launch.status) ? 'current' : 'history';
      return json(res, 200, { ok: true, run, launch, snapshotKind,
        acceptance: resolveTeamAcceptance({ wsRoot, run }) });
    } catch {
      return json(res, 500, { error: '天团运行记录读取失败，请检查文件格式、大小与存储权限' });
    }
  };
}
