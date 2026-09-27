import { reviewStoragePath } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';
import { resolveTeamAcceptance } from './team-acceptance.mjs';

// Kept separate from server startup so the real read path can run in isolation.
export function createTeamRunRead({ wsRoot, json, getLaunch }) {
  return res => {
    try {
      const file = reviewStoragePath(wsRoot, '工程/多AI角色扮演系统/team-run.json');
      const launch = getLaunch();
      let raw;
      try { raw = readReviewBounded(file, 16_000_000); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        return json(res, 200, { ok: true, run: null, launch, snapshotKind: 'none',
          hint: '通过天团启动入口提交视频脚本任务后，这里会显示运行记录。' });
      }
      const run = JSON.parse(raw.toString('utf8'));
      if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('Invalid snapshot');
      const snapshotKind = run.launchId && run.launchId === launch?.id && ['launching', 'running'].includes(launch.status) ? 'current' : 'history';
      return json(res, 200, { ok: true, run, launch, snapshotKind,
        acceptance: resolveTeamAcceptance({ wsRoot, run }) });
    } catch {
      return json(res, 500, { error: '天团运行记录读取失败，请检查文件格式、大小与存储权限' });
    }
  };
}
